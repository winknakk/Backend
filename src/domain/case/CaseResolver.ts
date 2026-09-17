/**
 * CaseResolver.ts
 *
 * Domain service for TicketX Flow 6 Full Flow Revision:
 * Multi-Case Context Resolution & Intelligent Case Switching.
 *
 * Core Principle:
 *   RESOLVE FIRST -> AUTHORIZE SECOND -> UPDATE CONTEXT THIRD -> ROUTE FOURTH -> ASK CUSTOMER ONLY IF AMBIGUOUS
 *
 * Resolution Priority:
 *   P0 — Explicit NEW CASE
 *   P1 — Exact CASE reference
 *   P2 — Explicit / strong semantic CASE reference
 *   P3 — Conversational continuation of ACTIVE CASE
 *   P4 — Recent-context CASE
 *   P5 — Closed CASE reference
 *   P6 — Ambiguous CASE
 *   P7 — Clearly NEW unrelated problem
 *
 * Hard Invariants:
 * - active_ticket_id is purely conversational focus, NEVER authorization.
 * - Customer choice is a FALLBACK when system cannot safely determine intended case.
 * - issue_category is EVIDENCE ONLY, NEVER a unique case identifier.
 * - Short messages ("ยังไม่ได้ครับ") and image-only messages continue active case without clarification prompt.
 * - Closed tickets MUST NOT be written to or implicitly reopened (referenced_ticket_id separated from routing_ticket_id).
 */

export interface CaseCandidate {
  id: number;
  ticket_number: string;
  ticket_id?: string | null;
  subject?: string | null;
  title?: string | null;
  summary?: string | null;
  running_summary?: string | null;
  original_problem_statement?: string | null;
  searchable_text?: string | null;
  issue_category?: string | null;
  status?: string | null;
  slug?: string | null;
  created_at?: string | Date | null;
}

export type CaseResolutionType =
  | "CONTINUE_ACTIVE_CASE"
  | "SWITCH_EXISTING_CASE"
  | "NEW_CASE"
  | "CLOSED_CASE_REFERENCE"
  | "AMBIGUOUS_CASE";

export interface CaseResolutionResult {
  /** Canonical typed decision outcome */
  decision: CaseResolutionType;
  /** Backward-compatible alias for decision */
  intent: CaseResolutionType;
  type: CaseResolutionType;
  /** Resolved routing ticket ID (null for NEW_CASE, CLOSED_CASE_REFERENCE, or AMBIGUOUS_CASE) */
  ticketId: number | null;
  /** Decoupled referenced ticket ID if customer referenced a closed ticket */
  referencedTicketId?: number | null;
  ticketNumber?: string | null;
  confidence: number;
  candidates?: number[];
  candidatesDetails?: CaseCandidate[];
  evidence: string[];
  reason: string;
  initialSubject?: string;
  clarificationPrompt?: string;
  actions?: Array<{ label: string; value: string; style?: "primary" | "default" }>;
}

export interface CaseResolverInput {
  conversationId: number;
  activeTicketId?: number | null;
  messageText: string;
  openCases: CaseCandidate[];
  closedCases: CaseCandidate[];
  recentMessages?: Array<{ id?: number; content: string; ticket_id?: number | null; role: string }>;
  hasAttachments?: boolean;
  imageOnly?: boolean;
}

export class CaseResolver {
  /**
   * Resolves the customer's intent for the current turn using deterministic P0-P7 priorities.
   */
  resolve(input: CaseResolverInput): CaseResolutionResult {
    const rawText = String(input.messageText || "").trim();
    const openCases = input.openCases || [];
    const closedCases = input.closedCases || [];
    const activeTicketId = input.activeTicketId ? Number(input.activeTicketId) : null;
    const activeCase = openCases.find((c) => c.id === activeTicketId) || null;
    const hasAttachments = Boolean(input.hasAttachments || input.imageOnly);
    const recentMessages = input.recentMessages || [];

    // ─────────────────────────────────────────────────────────────
    // 0. Empty / Attachment-Only Turns
    // ─────────────────────────────────────────────────────────────
    if (!rawText) {
      if (activeCase) {
        return {
          decision: "CONTINUE_ACTIVE_CASE",
          intent: "CONTINUE_ACTIVE_CASE",
          type: "CONTINUE_ACTIVE_CASE",
          ticketId: activeCase.id,
          ticketNumber: activeCase.ticket_number,
          confidence: 0.98,
          evidence: ["EMPTY_OR_ATTACHMENT_ONLY_WITH_ACTIVE_CASE"],
          reason: hasAttachments ? "ATTACHMENT_ONLY_ACTIVE_CASE" : "EMPTY_TEXT_ACTIVE_CASE",
        };
      }
      if (openCases.length === 1) {
        return {
          decision: "CONTINUE_ACTIVE_CASE",
          intent: "CONTINUE_ACTIVE_CASE",
          type: "CONTINUE_ACTIVE_CASE",
          ticketId: openCases[0].id,
          ticketNumber: openCases[0].ticket_number,
          confidence: 0.95,
          evidence: ["ATTACHMENT_ONLY_SINGLE_OPEN_CASE"],
          reason: "ATTACHMENT_ONLY_SINGLE_OPEN_CASE",
        };
      }
      if (openCases.length > 1) {
        return this.buildAmbiguityResult(openCases, "ATTACHMENT_WITHOUT_ACTIVE_TICKET");
      }
      return {
        decision: "NEW_CASE",
        intent: "NEW_CASE",
        type: "NEW_CASE",
        ticketId: null,
        confidence: 0.75,
        evidence: ["ATTACHMENT_NO_OPEN_CASES"],
        reason: "ATTACHMENT_NO_OPEN_CASES",
        initialSubject: "เอกสารแนบจากลูกค้า",
      };
    }

    const text = rawText;
    const lowerText = text.toLowerCase();

    // ─────────────────────────────────────────────────────────────
    // P0 — Explicit NEW CASE
    // e.g. "เปิดเคสใหม่", "เปิดตั๋วใหม่", "+ แจ้งปัญหาใหม่", "report_issue", "open_new_case"
    // ─────────────────────────────────────────────────────────────
    const isExplicitNewCase =
      /^(?:(?:\+|\/)?(?:แจ้งปัญหาใหม่|เปิดเคสใหม่|เปิดตั๋วใหม่|สร้างเคสใหม่|report_issue|new_case|แจ้งอีกเรื่อง|มีอีกหนึ่งปัญหา)|(?:\+ แจ้งปัญหาใหม่))$/i.test(
        text
      ) ||
      text.startsWith("open_new_case") ||
      text.startsWith("เปิดเคสใหม่:") ||
      text.startsWith("เปิดเคสใหม่");

    if (isExplicitNewCase) {
      let subject = "ปัญหาใหม่จากลูกค้า";
      if (text.startsWith("เปิดเคสใหม่:")) {
        const sub = text.replace(/^เปิดเคสใหม่:\s*/, "").trim();
        if (sub) subject = sub.slice(0, 80);
      } else if (text.startsWith("เปิดเคสใหม่")) {
        const sub = text.replace(/^เปิดเคสใหม่\s*/, "").trim();
        if (sub) subject = sub.slice(0, 80);
      } else if (text.length > 15 && !text.startsWith("+") && !text.startsWith("/")) {
        subject = text.slice(0, 80);
      }

      return {
        decision: "NEW_CASE",
        intent: "NEW_CASE",
        type: "NEW_CASE",
        ticketId: null,
        confidence: 0.98,
        initialSubject: subject,
        evidence: ["P0_EXPLICIT_NEW_CASE_REQUEST"],
        reason: "EXPLICIT_NEW_CASE_REQUEST",
      };
    }

    // ─────────────────────────────────────────────────────────────
    // P1 — Exact CASE Reference
    // e.g. "TCK-2026-12345", "#550", exact legacy ticket_id
    // ─────────────────────────────────────────────────────────────
    const tckMatch = text.match(/TCK-[A-Za-z0-9_-]+/i);
    const hashIdMatch = text.match(/#(\d+)\b/);
    const exactIdentifier = tckMatch ? tckMatch[0].toUpperCase() : hashIdMatch ? hashIdMatch[1] : null;

    if (exactIdentifier) {
      // Check closed cases first: MUST NOT reopen or write to closed case
      const matchedClosed = closedCases.find(
        (c) =>
          c.ticket_number?.toUpperCase() === exactIdentifier ||
          String(c.id) === exactIdentifier ||
          c.ticket_id?.toUpperCase() === exactIdentifier
      );
      if (matchedClosed) {
        return this.buildClosedCaseResult(matchedClosed, text, openCases, ["P1_EXACT_CLOSED_TICKET_MATCH"]);
      }

      const matchedOpen = openCases.find(
        (c) =>
          c.ticket_number?.toUpperCase() === exactIdentifier ||
          String(c.id) === exactIdentifier ||
          c.ticket_id?.toUpperCase() === exactIdentifier
      );
      if (matchedOpen) {
        const isAlreadyActive = activeCase && activeCase.id === matchedOpen.id;
        return {
          decision: isAlreadyActive ? "CONTINUE_ACTIVE_CASE" : "SWITCH_EXISTING_CASE",
          intent: isAlreadyActive ? "CONTINUE_ACTIVE_CASE" : "SWITCH_EXISTING_CASE",
          type: isAlreadyActive ? "CONTINUE_ACTIVE_CASE" : "SWITCH_EXISTING_CASE",
          ticketId: matchedOpen.id,
          ticketNumber: matchedOpen.ticket_number,
          confidence: 1.0,
          evidence: [`P1_EXACT_TICKET_NUMBER_MATCH: ${matchedOpen.ticket_number}`],
          reason: `EXACT_TICKET_NUMBER_MATCH: ${matchedOpen.ticket_number}`,
        };
      }
    }

    // ─────────────────────────────────────────────────────────────
    // P7 (Early check for unambiguous new problem markers)
    // Phrases explicitly introducing an unrelated new issue
    // ─────────────────────────────────────────────────────────────
    const isNewProblemStatement =
      /(?:อีกเรื่องครับ|อีกเรื่องค่ะ|มีอีกเรื่อง|อีกเรื่องนึง|มีปัญหาใหม่อีกเรื่อง|แจ้งเรื่องใหม่|ขอเปิดเคสใหม่อีกเคส|นอกจากเรื่องเดิม)/i.test(
        text
      );

    if (isNewProblemStatement) {
      const initialSubject =
        text
          .replace(
            /^(?:(?:อีกเรื่องครับ|อีกเรื่องค่ะ|มีอีกเรื่อง|อีกเรื่องนึง|มีปัญหาใหม่อีกเรื่อง|แจ้งเรื่องใหม่|ขอเปิดเคสใหม่อีกเคส|นอกจากเรื่องเดิม)[,:\s]*)/i,
            ""
          )
          .trim()
          .slice(0, 80) || "แจ้งปัญหาใหม่จากลูกค้า";

      return {
        decision: "NEW_CASE",
        intent: "NEW_CASE",
        type: "NEW_CASE",
        ticketId: null,
        confidence: 0.95,
        initialSubject,
        evidence: ["P7_CLEARLY_NEW_ISSUE_STATEMENT"],
        reason: "CLEARLY_NEW_ISSUE_STATEMENT",
      };
    }

    // ─────────────────────────────────────────────────────────────
    // P2 — Explicit Identifier / Ordinal / Slug Match
    // ─────────────────────────────────────────────────────────────
    const ordinalIndex = this.extractOrdinalIndex(lowerText);
    if (ordinalIndex !== null) {
      if (openCases.length > ordinalIndex) {
        const targetCase = openCases[ordinalIndex];
        const isAlreadyActive = activeCase && activeCase.id === targetCase.id;
        return {
          decision: isAlreadyActive ? "CONTINUE_ACTIVE_CASE" : "SWITCH_EXISTING_CASE",
          intent: isAlreadyActive ? "CONTINUE_ACTIVE_CASE" : "SWITCH_EXISTING_CASE",
          type: isAlreadyActive ? "CONTINUE_ACTIVE_CASE" : "SWITCH_EXISTING_CASE",
          ticketId: targetCase.id,
          ticketNumber: targetCase.ticket_number,
          confidence: 0.96,
          evidence: [`P2_ORDINAL_CASE_INDEX_MATCH: index ${ordinalIndex} -> ${targetCase.ticket_number}`],
          reason: `ORDINAL_CASE_INDEX_MATCH: index ${ordinalIndex} -> ${targetCase.ticket_number}`,
        };
      } else if (openCases.length + closedCases.length > ordinalIndex) {
        const closedIdx = ordinalIndex - openCases.length;
        const targetClosed = closedCases[closedIdx];
        if (targetClosed) {
          return this.buildClosedCaseResult(targetClosed, text, openCases, ["P2_ORDINAL_CLOSED_CASE_MATCH"]);
        }
      }
    }

    // Slug / Legacy identifier exact match
    const slugMatchOpen = openCases.find((c) => this.matchSlug(lowerText, c));
    if (slugMatchOpen) {
      const isAlreadyActive = activeCase && activeCase.id === slugMatchOpen.id;
      return {
        decision: isAlreadyActive ? "CONTINUE_ACTIVE_CASE" : "SWITCH_EXISTING_CASE",
        intent: isAlreadyActive ? "CONTINUE_ACTIVE_CASE" : "SWITCH_EXISTING_CASE",
        type: isAlreadyActive ? "CONTINUE_ACTIVE_CASE" : "SWITCH_EXISTING_CASE",
        ticketId: slugMatchOpen.id,
        ticketNumber: slugMatchOpen.ticket_number,
        confidence: 0.95,
        evidence: [`P2_SLUG_MATCH: ${slugMatchOpen.ticket_number}`],
        reason: `SLUG_LEGACY_IDENTIFIER_MATCH: ${slugMatchOpen.ticket_number}`,
      };
    }

    const slugMatchClosed = closedCases.find((c) => this.matchSlug(lowerText, c));
    if (slugMatchClosed) {
      return this.buildClosedCaseResult(slugMatchClosed, text, openCases, ["P2_SLUG_CLOSED_CASE_MATCH"]);
    }

    // ─────────────────────────────────────────────────────────────
    // P3 — Conversational Continuation of ACTIVE CASE
    // Short confirmations, affirmations, image-only, or follow-ups.
    // ─────────────────────────────────────────────────────────────
    const isShortAffirmative = this.isShortOrAffirmativeMessage(text);
    if (activeCase && isShortAffirmative) {
      return {
        decision: "CONTINUE_ACTIVE_CASE",
        intent: "CONTINUE_ACTIVE_CASE",
        type: "CONTINUE_ACTIVE_CASE",
        ticketId: activeCase.id,
        ticketNumber: activeCase.ticket_number,
        confidence: 0.94,
        evidence: ["P3_ACTIVE_CASE_SHORT_AFFIRMATIVE"],
        reason: "ACTIVE_CASE_DEFAULT_SHORT_AFFIRMATIVE",
      };
    }

    // ─────────────────────────────────────────────────────────────
    // P2 / P5 / P6 — Semantic Matching & Evidence Stacking
    // Evaluates subject, title, summary, running_summary, original_problem_statement,
    // and searchable_text across all open and closed cases.
    // NOTE: issue_category contributes evidence (+0.10) ONLY when other signals corroborate;
    // it NEVER acts as a unique case identifier.
    // ─────────────────────────────────────────────────────────────
    const hasExplicitSwitchWord = /(?:สลับ|เปลี่ยน|กลับไป|ไปที่|ดูเรื่อง|ตามเรื่อง|ขอเรื่อง)/i.test(text);

    const openScores = openCases.map((c) => {
      const evaluation = this.evaluateCandidateEvidence(lowerText, c);
      return {
        candidate: c,
        score: evaluation.score,
        evidence: evaluation.evidence,
        isClosed: false,
      };
    });

    const closedScores = closedCases.map((c) => {
      const evaluation = this.evaluateCandidateEvidence(lowerText, c);
      return {
        candidate: c,
        score: evaluation.score,
        evidence: evaluation.evidence,
        isClosed: true,
      };
    });

    const allScores = [...openScores, ...closedScores]
      .filter((s) => s.score >= 0.45)
      .sort((a, b) => b.score - a.score);

    if (allScores.length > 0) {
      const topMatch = allScores[0];

      // P5: Closed Case Reference
      if (topMatch.isClosed && topMatch.score >= 0.50) {
        return this.buildClosedCaseResult(topMatch.candidate, text, openCases, topMatch.evidence);
      }

      // Check for Ambiguity among competing open cases
      const competingOpen = openScores.filter(
        (s) => s.score >= 0.45 && s.score >= topMatch.score - 0.15
      );

      // Section 4 Hard Rule: If competing cases share the same issue_category
      // and lack distinctive text evidence, they MUST trigger AMBIGUOUS_CASE.
      if (competingOpen.length > 1) {
        // Active Case Bias: If active case is one of the competitors AND customer
        // message does NOT have explicit switch intent, bias towards continuing active case.
        if (activeCase && !hasExplicitSwitchWord) {
          const activeCompeting = competingOpen.find((c) => c.candidate.id === activeCase.id);
          if (activeCompeting) {
            return {
              decision: "CONTINUE_ACTIVE_CASE",
              intent: "CONTINUE_ACTIVE_CASE",
              type: "CONTINUE_ACTIVE_CASE",
              ticketId: activeCase.id,
              ticketNumber: activeCase.ticket_number,
              confidence: 0.88,
              evidence: [...activeCompeting.evidence, "ACTIVE_CASE_BIAS_OVER_AMBIGUOUS_MATCH"],
              reason: "ACTIVE_CASE_BIAS_OVER_AMBIGUOUS_MATCH",
            };
          }
        }

        // True Ambiguity: P6 AMBIGUOUS_CASE
        const candidates = competingOpen.map((m) => m.candidate);
        return this.buildAmbiguityResult(candidates, `AMBIGUOUS_EVIDENCE_BETWEEN_${candidates.length}_CASES`);
      }

      // P2: Strong Semantic Match on an Open Case
      if (topMatch.score >= 0.45 && !topMatch.isClosed) {
        const isAlreadyActive = activeCase && activeCase.id === topMatch.candidate.id;
        return {
          decision: isAlreadyActive ? "CONTINUE_ACTIVE_CASE" : "SWITCH_EXISTING_CASE",
          intent: isAlreadyActive ? "CONTINUE_ACTIVE_CASE" : "SWITCH_EXISTING_CASE",
          type: isAlreadyActive ? "CONTINUE_ACTIVE_CASE" : "SWITCH_EXISTING_CASE",
          ticketId: topMatch.candidate.id,
          ticketNumber: topMatch.candidate.ticket_number,
          confidence: topMatch.score,
          evidence: topMatch.evidence,
          reason: `STRONG_CASE_SEMANTIC_MATCH: ${topMatch.candidate.ticket_number}`,
        };
      }
    }

    // ─────────────────────────────────────────────────────────────
    // P3 — Conversational Continuation of ACTIVE CASE
    // If active case is valid and open, and no explicit switch or stronger match was found,
    // continue the active case (P3).
    // ─────────────────────────────────────────────────────────────
    if (activeCase) {
      return {
        decision: "CONTINUE_ACTIVE_CASE",
        intent: "CONTINUE_ACTIVE_CASE",
        type: "CONTINUE_ACTIVE_CASE",
        ticketId: activeCase.id,
        ticketNumber: activeCase.ticket_number,
        confidence: 0.88,
        evidence: ["P3_ACTIVE_CASE_CONTINUATION"],
        reason: "CONTINUE_ACTIVE_CASE_FOCUS",
      };
    }

    // ─────────────────────────────────────────────────────────────
    // P4 — Recent-Context CASE Resolution
    // If no active case is set, resolve to the most recently discussed open case.
    // ─────────────────────────────────────────────────────────────
    if (recentMessages.length > 0) {
      const lastMsgWithCase = recentMessages
        .slice()
        .reverse()
        .find((m) => m.ticket_id && openCases.some((c) => c.id === Number(m.ticket_id)));

      if (lastMsgWithCase && lastMsgWithCase.ticket_id) {
        const recentTicketId = Number(lastMsgWithCase.ticket_id);
        const targetRecentCase = openCases.find((c) => c.id === recentTicketId);
        if (targetRecentCase) {
          return {
            decision: "SWITCH_EXISTING_CASE",
            intent: "SWITCH_EXISTING_CASE",
            type: "SWITCH_EXISTING_CASE",
            ticketId: targetRecentCase.id,
            ticketNumber: targetRecentCase.ticket_number,
            confidence: 0.85,
            evidence: [`P4_RECENT_CONTEXT_CASE: ${targetRecentCase.ticket_number}`],
            reason: `RECENT_CONTEXT_CASE_SWITCH: ${targetRecentCase.ticket_number}`,
          };
        }
      }
    }

    if (openCases.length === 1) {
      return {
        decision: "CONTINUE_ACTIVE_CASE",
        intent: "CONTINUE_ACTIVE_CASE",
        type: "CONTINUE_ACTIVE_CASE",
        ticketId: openCases[0].id,
        ticketNumber: openCases[0].ticket_number,
        confidence: 0.85,
        evidence: ["P3_SINGLE_OPEN_CASE_DEFAULT"],
        reason: "SINGLE_OPEN_CASE_DEFAULT",
      };
    }

    // If multiple open cases exist but no active ticket is set and message has no clear match:
    if (openCases.length > 1) {
      return this.buildAmbiguityResult(openCases, "NO_ACTIVE_TICKET_AMBIGUOUS_FALLTHROUGH");
    }

    // No open cases exist: P7 create a new case
    return {
      decision: "NEW_CASE",
      intent: "NEW_CASE",
      type: "NEW_CASE",
      ticketId: null,
      confidence: 0.80,
      evidence: ["P7_NO_OPEN_CASES_NEW_CASE_FALLTHROUGH"],
      initialSubject: text.slice(0, 80),
      reason: "NO_OPEN_CASES_NEW_CASE_FALLTHROUGH",
    };
  }

  /**
   * Evaluates evidence stacking across all fields of a candidate case.
   */
  private evaluateCandidateEvidence(
    lowerText: string,
    c: CaseCandidate
  ): { score: number; evidence: string[] } {
    const evidence: string[] = [];
    let score = 0;

    const subject = (c.subject || c.title || "").toLowerCase();
    const summary = (c.summary || "").toLowerCase();
    const running = (c.running_summary || "").toLowerCase();
    const problem = (c.original_problem_statement || "").toLowerCase();
    const searchable = (c.searchable_text || "").toLowerCase();
    const category = (c.issue_category || "").toLowerCase();

    // 1. Direct Substring Match on Subject
    if (subject.length >= 4 && lowerText.includes(subject)) {
      score += 0.55;
      evidence.push(`SUBJECT_SUBSTRING_MATCH: "${subject}"`);
    }

    // 2. Significant Keywords Across All Narrative Fields
    const fullNarrative = `${subject} ${summary} ${running} ${problem} ${searchable}`;
    const tokens = this.extractSignificantKeywords(fullNarrative);

    if (tokens.length > 0) {
      let matchedTokens = 0;
      for (const token of tokens) {
        if (lowerText.includes(token)) {
          matchedTokens++;
        }
      }
      const tokenRatio = matchedTokens / tokens.length;
      if (tokenRatio > 0.15) {
        score += tokenRatio * 0.65;
        evidence.push(`TOKEN_MATCH_RATIO: ${tokenRatio.toFixed(2)} (${matchedTokens}/${tokens.length})`);
      }
    }

    // 3. Explicit Switch Phrases ("เรื่อง...", "เกี่ยวกับ...", "กลับไป...", "ไปที่...")
    const cleanText = lowerText.replace(/(?:ครับ|ค่ะ|คับ|นะคะ|นะครับ|หน่อย|ด้วย)$/g, "").trim();
    const switchMatch = cleanText.match(/(?:กลับไปที่เรื่อง|กลับไปเรื่อง|กลับไปที่|กลับไป|สลับไปที่เรื่อง|สลับไปเรื่อง|สลับไปที่|สลับไป|เรื่อง|เกี่ยวกับ|เคส|ปัญหา|ไปที่)\s*(?:เรื่อง\s*)?([^\s,]+)/);
    if (switchMatch && switchMatch[1]) {
      let rawTopic = switchMatch[1].replace(/(?:ครับ|ค่ะ|คับ|นะคะ|นะครับ|หน่อย|ด้วย)$/g, "").trim();
      rawTopic = rawTopic.replace(/^เรื่อง/, "").trim();
      if (
        rawTopic.length >= 2 &&
        (subject.includes(rawTopic) || summary.includes(rawTopic) || running.includes(rawTopic) || searchable.includes(rawTopic))
      ) {
        score += 0.65;
        evidence.push(`EXPLICIT_TOPIC_MATCH: "${rawTopic}"`);
      }
    }

    // 4. Distinctive Domain Terms in Thai & English
    const domainTerms = [
      "ใบแจ้งหนี้", "เข้าไม่ได้", "เข้าสู่ระบบ", "ใบเสร็จ", "ยอดเงิน", "ยอดชำระ",
      "ที่อยู่", "แพ็กเกจ", "ราคา", "ภาษี", "เงินยืม", "สลิป", "ล็อกอิน", "รหัสผ่าน",
      "login", "invoice", "receipt", "billing", "address", "tax", "pricing", "password"
    ];
    for (const term of domainTerms) {
      if (cleanText.includes(term) && (subject.includes(term) || summary.includes(term) || running.includes(term) || searchable.includes(term))) {
        score += 0.50;
        evidence.push(`DOMAIN_TERM_MATCH: "${term}"`);
      }
    }

    // 5. Category Evidence (Evidence ONLY - adds corroboration if other fields matched)
    // Section 4 Hard Invariant: Category alone cannot select a case!
    if (category && cleanText.includes(category) && score > 0.20) {
      score += 0.10;
      evidence.push(`CATEGORY_CORROBORATION: "${category}"`);
    }

    return { score: Math.min(score, 0.99), evidence };
  }

  /**
   * Builds closed-case reference outcome. Decouples referenced_ticket_id from routing ticketId.
   */
  private buildClosedCaseResult(
    closedCase: CaseCandidate,
    originalText: string,
    openCases: CaseCandidate[],
    evidence: string[]
  ): CaseResolutionResult {
    const ticketNum = closedCase.ticket_number || `#${closedCase.id}`;
    const subject = closedCase.subject || closedCase.title || closedCase.summary || "เคสที่ปิดแล้ว";

    const actions: Array<{ label: string; value: string; style?: "primary" | "default" }> = [
      { label: `➕ เปิดเคสใหม่จากเรื่องนี้`, value: `เปิดเคสใหม่: ติดตามต่อจาก ${ticketNum}`, style: "primary" },
    ];

    if (openCases.length > 0) {
      actions.push({
        label: `📋 ดูตั๋วงานที่เปิดอยู่ (${openCases.length})`,
        value: `ดูรายการตั๋วที่เปิดอยู่`,
      });
    }

    return {
      decision: "CLOSED_CASE_REFERENCE",
      intent: "CLOSED_CASE_REFERENCE",
      type: "CLOSED_CASE_REFERENCE",
      ticketId: null, // Hard Invariant: message must NEVER be attached to closed case
      referencedTicketId: closedCase.id,
      ticketNumber: ticketNum,
      confidence: 0.98,
      evidence: [...evidence, `CLOSED_CASE_PROTECTION: ${ticketNum}`],
      reason: `CLOSED_CASE_PROTECTION: ${ticketNum}`,
      clarificationPrompt: `เคส ${ticketNum} ("${subject}") ได้รับการปิดเรียบร้อยแล้วค่ะ\n\nระบบไม่สามารถเพิ่มข้อมูลลงในเคสที่ปิดแล้วได้ หากท่านต้องการความช่วยเหลือเพิ่มเติม สามารถเลือกเปิดเคสใหม่ได้ทันทีค่ะ`,
      actions,
    };
  }

  /**
   * Builds ambiguous case outcome with options for customer selection.
   */
  private buildAmbiguityResult(candidates: CaseCandidate[], reason: string): CaseResolutionResult {
    const actions: Array<{ label: string; value: string; style?: "primary" | "default" }> = candidates.slice(0, 4).map((c) => ({
      label: `${c.subject || c.title || c.ticket_number}`,
      value: `สลับไปที่ ${c.ticket_number}`,
    }));
    actions.push({
      label: `➕ แจ้งเรื่องใหม่`,
      value: `เปิดเคสใหม่`,
    });

    return {
      decision: "AMBIGUOUS_CASE",
      intent: "AMBIGUOUS_CASE",
      type: "AMBIGUOUS_CASE",
      ticketId: null,
      confidence: 0.50,
      evidence: [`AMBIGUOUS_BETWEEN_${candidates.length}_CASES`],
      reason,
      candidates: candidates.map((c) => c.id),
      candidatesDetails: candidates,
      clarificationPrompt: `ได้ค่ะ ตอนนี้มี ${candidates.length} เคสที่กำลังดำเนินการอยู่ ต้องการแจ้งข้อมูลเพิ่มเติมเรื่องไหนคะ?`,
      actions,
    };
  }

  /**
   * Checks if message is short, affirmative, or a simple acknowledgment that continues active discussion.
   */
  private isShortOrAffirmativeMessage(text: string): boolean {
    const clean = text.trim();
    if (clean.length <= 40) {
      if (
        /^(?:ยังไม่ได้(?:ครับ|ค่ะ|คับ)?|ได้แล้ว(?:ครับ|ค่ะ|คับ)?|โอเค(?:ครับ|ค่ะ)?|ok|yes|no|ใช่(?:ครับ|ค่ะ)?|ไม่ใช่|ขอบคุณ(?:ครับ|ค่ะ)?|เรียบร้อย(?:ครับ|ค่ะ)?|ส่งให้แล้ว(?:ครับ|ค่ะ)?|ตามนั้น(?:ครับ|ค่ะ)?|ครับ|ค่ะ|คับ|แนบรูป(?:ให้แล้ว|ครับ|ค่ะ)?|รูปครับ|รูปค่ะ|ลองแล้ว(?:ครับ|ค่ะ)?|ยังเหมือนเดิม(?:ครับ|ค่ะ)?|กำลังลอง(?:ครับ|ค่ะ)?|ทดสอบแล้ว(?:ครับ|ค่ะ)?|รอก่อน(?:ครับ|ค่ะ)?|ยังเลย(?:ครับ|ค่ะ)?|ยังไม่ได้รับ(?:ครับ|ค่ะ)?|เดี๋ยวลองใหม่(?:ครับ|ค่ะ)?|ได้ครับ|ได้ค่ะ|ยังมีปัญหาอยู่|อันนี้ครับ|อันนี้ค่ะ|นี่ครับ|นี่ค่ะ|ตามนี้ครับ|ตามนี้ค่ะ)$/i.test(
          clean
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Matches slug or legacy identifier.
   */
  private matchSlug(lowerText: string, c: CaseCandidate): boolean {
    const identifiers = [c.slug, c.ticket_id].filter(Boolean) as string[];
    for (const id of identifiers) {
      const cleanId = id.toLowerCase().trim();
      if (cleanId.length >= 3 && lowerText.includes(cleanId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Extracts ordinal case index (0-based) from text.
   */
  private extractOrdinalIndex(lowerText: string): number | null {
    if (/(?:เรื่องแรก|เรื่องที่หนึ่ง|เคสแรก|เคสที่หนึ่ง|ตั๋วแรก|เคส 1|เคส1|ตั๋ว 1|ตั๋ว1|อันแรก|อันที่หนึ่ง|case 1|ticket 1)/i.test(lowerText)) {
      return 0;
    }
    if (/(?:เรื่องที่สอง|เคสที่สอง|เคส 2|เคส2|ตั๋ว 2|ตั๋ว2|อันที่สอง|case 2|ticket 2)/i.test(lowerText)) {
      return 1;
    }
    if (/(?:เรื่องที่สาม|เคสที่สาม|เคส 3|เคส3|ตั๋ว 3|ตั๋ว3|อันที่สาม|case 3|ticket 3)/i.test(lowerText)) {
      return 2;
    }
    if (/(?:เรื่องที่สี่|เคสที่สี่|เคส 4|เคส4|ตั๋ว 4|ตั๋ว4|case 4|ticket 4)/i.test(lowerText)) {
      return 3;
    }
    return null;
  }

  private extractSignificantKeywords(rawText: string): string[] {
    const cleaned = rawText
      .replace(/[^\u0E00-\u0E7Fa-zA-Z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const words = cleaned.split(" ").filter((w) => w.length >= 3);
    const stopWords = new Set([
      "และ", "หรือ", "ของ", "จาก", "ใน", "ที่", "มี", "ได้", "ให้", "กับ", "เป็น",
      "การ", "ความ", "ครับ", "ค่ะ", "นะคะ", "นะครับ", "หน่อย", "ด้วย", "นี้", "นั้น",
      "the", "and", "or", "for", "with", "this", "that"
    ]);

    return Array.from(new Set(words.filter((w) => !stopWords.has(w.toLowerCase()))));
  }
}

export const caseResolver = new CaseResolver();
