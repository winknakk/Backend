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
  outcome: CaseResolutionType;
  /** Backward-compatible alias for outcome */
  decision: CaseResolutionType;
  /** Backward-compatible alias for outcome */
  intent: CaseResolutionType;
  type: CaseResolutionType;
  /** Canonical resolved routing ticket ID (null for NEW_CASE, CLOSED_CASE_REFERENCE, or AMBIGUOUS_CASE) */
  routingTicketId: number | null;
  /** Backward-compatible alias for routingTicketId */
  ticketId: number | null;
  /** Decoupled referenced ticket ID if customer referenced a closed ticket (null if none) */
  referencedTicketId: number | null;
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

/**
 * Words that follow "เคส / ปัญหา / เรื่อง" without naming a topic — urgency and
 * context words ("เป็นเคสด่วนมาก", "ปัญหาใหม่", "เรื่องเดิม"). Seen live
 * 2026-09-17: "…และเป็นเคสด่วนมากครับ" matched a closed case whose summary
 * also said "ด่วนมาก" and the customer got the closed-case protection instead
 * of the new-case summary. Such a word is never an EXPLICIT_TOPIC_MATCH.
 */
const GENERIC_TOPIC_WORDS =
  /^(?:ด่วน|ด่วนมาก|ด่วนที่สุด|ด่วนสุด|เร่งด่วน|ใหม่|เดิม|เก่า|นี้|นั้น|นี่|ล่าสุด|ก่อนหน้า|ก่อน|เพิ่ม|เพิ่มเติม|ต่อ|เลย|มาก|ไหน|อะไร|ที่แล้ว|ที่ผ่านมา|สำคัญ|ปกติ|ทั่วไป|urgent|new|old|same)ๆ?$/i;

/**
 * Where a topic is named: "เรื่อง X", "เกี่ยวกับ X", "กลับไปเรื่อง X", "ปัญหา X" …
 * The capture is the raw topic up to the next space; `normalizeTopic` strips
 * the particles that Thai glues onto it.
 */
const TOPIC_REFERENCE_PATTERN =
  /(?:ขอกลับมาดูเรื่อง|กลับมาดูเรื่อง|ขอกลับมาที่เรื่อง|ขอกลับมาเรื่อง|กลับมาที่เรื่อง|กลับมาเรื่อง|กลับมาที่|กลับมา|ขอกลับไปที่เรื่อง|ขอกลับไปเรื่อง|กลับไปที่เรื่อง|กลับไปเรื่อง|กลับไปที่|กลับไป|สลับไปที่เรื่อง|สลับไปเรื่อง|สลับไปที่|สลับไป|เรื่อง|เกี่ยวกับ|เคส|ปัญหา|ไปที่)\s*(?:เรื่อง\s*)?([^\s,?!]+)/;

/**
 * Particles and question tails Thai glues onto a topic word ("ระบบล่ะคะ",
 * "ยอดเงินหน่อยครับ", "เงินยืมหรือยัง"). Seen live 2026-09-18 (conversation
 * 99961): "แล้วเรื่องระบบล่ะคะ" carried the topic "ระบบล่ะคะ", matched no
 * subject, and the active case answered a question about the other one.
 */
const TOPIC_TAIL_PARTICLES =
  /(?:หรือยัง|หรือเปล่า|รึยัง|รึเปล่า|ล่ะ|ละ|บ้าง|อ่ะ|อะ|นะ|น้า|คะ|ค่ะ|ครับ|คับ|ค้าบ|จ้า|จ๊ะ|จ้ะ|เหรอ|หรอ|มั้ย|ไหม|หน่อย|ด้วย|เอ่ย)+$/;

/**
 * Contrastive topic-shift phrasing — "แล้วเรื่อง X ล่ะ", "ส่วนเรื่อง X",
 * "เรื่อง X ล่ะคะ" — means the customer is turning to ANOTHER subject. It
 * counts as explicit switch intent (no active-case bias), and a named topic
 * that fits none or several of the open cases is asked about, never guessed
 * (operator decision 2026-09-18).
 */
const TOPIC_SHIFT_MARKER =
  /(?:(?:^|\s)แล้ว\s*(?:เรื่อง|เคส|ปัญหา|ตั๋ว|ระบบ|ของ)|(?:^|\s)ส่วน\s*(?:เรื่อง|เคส|ปัญหา|ตั๋ว)|(?:ล่ะ|ละ)(?:\s*(?:คะ|ค่ะ|ครับ|คับ|ค้าบ|จ้า|จ๊ะ))?(?=\s|$|[?!.]))/;

/** Pure: "ระบบล่ะคะ" → "ระบบ"; a generic word ("ด่วนมาก", "เดิม") → "". */
export function normalizeTopic(raw: string): string {
  let topic = String(raw || "").trim();
  for (let i = 0; i < 4; i++) {
    const next = topic.replace(TOPIC_TAIL_PARTICLES, "").replace(/^(?:เรื่อง|ของ)/, "").trim();
    if (next === topic) break;
    topic = next;
  }
  if (!topic || GENERIC_TOPIC_WORDS.test(topic)) return "";
  return topic;
}

/** Pure: the normalized topic the message names, or "" when it names none. */
export function referencedTopic(lowerText: string): string {
  const m = String(lowerText || "").match(TOPIC_REFERENCE_PATTERN);
  return m && m[1] ? normalizeTopic(m[1]) : "";
}

/** Pure: true for "แล้วเรื่อง X ล่ะ" / "ส่วนเรื่อง X" / "… ล่ะคะ" phrasing. */
export function hasTopicShiftMarker(text: string): boolean {
  return TOPIC_SHIFT_MARKER.test(String(text || ""));
}

export class CaseResolver {
  /**
   * Helper to construct a typed, deterministic CaseResolutionResult satisfying ISSUE-080 contract.
   */
  private createResult(params: {
    decision: CaseResolutionType;
    routingTicketId?: number | null;
    ticketId?: number | null;
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
  }): CaseResolutionResult {
    const resolvedRouting = params.routingTicketId !== undefined ? params.routingTicketId : (params.ticketId ?? null);
    const resolvedRef = params.referencedTicketId ?? null;
    return {
      outcome: params.decision,
      decision: params.decision,
      intent: params.decision,
      type: params.decision,
      routingTicketId: resolvedRouting,
      ticketId: resolvedRouting,
      referencedTicketId: resolvedRef,
      ticketNumber: params.ticketNumber ?? null,
      confidence: params.confidence,
      candidates: params.candidates,
      candidatesDetails: params.candidatesDetails,
      evidence: params.evidence,
      reason: params.reason,
      initialSubject: params.initialSubject,
      clarificationPrompt: params.clarificationPrompt,
      actions: params.actions,
    };
  }

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
        return this.createResult({
          decision: "CONTINUE_ACTIVE_CASE",
          ticketId: activeCase.id,
          ticketNumber: activeCase.ticket_number,
          confidence: 0.98,
          evidence: ["EMPTY_OR_ATTACHMENT_ONLY_WITH_ACTIVE_CASE"],
          reason: hasAttachments ? "ATTACHMENT_ONLY_ACTIVE_CASE" : "EMPTY_TEXT_ACTIVE_CASE",
        });
      }
      if (openCases.length === 1) {
        return this.createResult({
          decision: "CONTINUE_ACTIVE_CASE",
          ticketId: openCases[0].id,
          ticketNumber: openCases[0].ticket_number,
          confidence: 0.95,
          evidence: ["ATTACHMENT_ONLY_SINGLE_OPEN_CASE"],
          reason: "ATTACHMENT_ONLY_SINGLE_OPEN_CASE",
        });
      }
      if (openCases.length > 1) {
        return this.buildAmbiguityResult(openCases, "ATTACHMENT_WITHOUT_ACTIVE_TICKET");
      }
      return this.createResult({
        decision: "NEW_CASE",
        ticketId: null,
        confidence: 0.75,
        evidence: ["ATTACHMENT_NO_OPEN_CASES"],
        reason: "ATTACHMENT_NO_OPEN_CASES",
        initialSubject: "เอกสารแนบจากลูกค้า",
      });
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

      return this.createResult({
        decision: "NEW_CASE",
        ticketId: null,
        confidence: 0.98,
        initialSubject: subject,
        evidence: ["P0_EXPLICIT_NEW_CASE_REQUEST"],
        reason: "EXPLICIT_NEW_CASE_REQUEST",
      });
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
        return this.createResult({
          decision: isAlreadyActive ? "CONTINUE_ACTIVE_CASE" : "SWITCH_EXISTING_CASE",
          ticketId: matchedOpen.id,
          ticketNumber: matchedOpen.ticket_number,
          confidence: 1.0,
          evidence: [`P1_EXACT_TICKET_NUMBER_MATCH: ${matchedOpen.ticket_number}`],
          reason: `EXACT_TICKET_NUMBER_MATCH: ${matchedOpen.ticket_number}`,
        });
      }
    }

    // ─────────────────────────────────────────────────────────────
    // P7 (Early check for unambiguous new problem markers)
    // Phrases explicitly introducing an unrelated new issue
    // ─────────────────────────────────────────────────────────────
    const isNewProblemStatement =
      // Aligned with the flow's NEW_ISSUE_NET (2026-09-17): "มีอีกปัญหาครับ …" resolved to
      // CONTINUE_ACTIVE_CASE and the hint could not tell the hub not to fold.
      /(?:อีกเรื่องครับ|อีกเรื่องค่ะ|มีอีกเรื่อง|อีกเรื่องนึง|มีปัญหาใหม่อีกเรื่อง|แจ้งเรื่องใหม่|ขอเปิดเคสใหม่อีกเคส|นอกจากเรื่องเดิม|(?:มี)?อีก\s*(?:ปัญหา|เคส|อย่าง)|เรื่องใหม่|ปัญหาใหม่|เคสใหม่|คนละเรื่อง|คนละปัญหา|คนละเคส|ไม่เกี่ยวกับเคส|อีกระบบ|another (?:issue|problem|case)|new (?:issue|problem|case)|separate (?:issue|case))/i.test(
        text
      );

    if (isNewProblemStatement) {
      const initialSubject =
        text
          .replace(
            /^(?:(?:อีกเรื่องครับ|อีกเรื่องค่ะ|มีอีกเรื่อง|อีกเรื่องนึง|มีปัญหาใหม่อีกเรื่อง|แจ้งเรื่องใหม่|ขอเปิดเคสใหม่อีกเคส|นอกจากเรื่องเดิม|(?:มี)?อีก\s*(?:ปัญหา|เคส|อย่าง)(?:ครับ|ค่ะ|คับ|นะ)?|เรื่องใหม่|ปัญหาใหม่|เคสใหม่|คนละเรื่อง|คนละปัญหา|คนละเคส)[,:\s]*)/i,
            ""
          )
          .trim()
          .slice(0, 80) || "แจ้งปัญหาใหม่จากลูกค้า";

      return this.createResult({
        decision: "NEW_CASE",
        ticketId: null,
        confidence: 0.95,
        initialSubject,
        evidence: ["P7_CLEARLY_NEW_ISSUE_STATEMENT"],
        reason: "CLEARLY_NEW_ISSUE_STATEMENT",
      });
    }

    // ─────────────────────────────────────────────────────────────
    // P2 — Explicit Identifier / Ordinal / Slug Match
    // ─────────────────────────────────────────────────────────────
    const ordinalIndex = this.extractOrdinalIndex(lowerText);
    if (ordinalIndex !== null) {
      if (openCases.length > ordinalIndex) {
        const targetCase = openCases[ordinalIndex];
        const isAlreadyActive = activeCase && activeCase.id === targetCase.id;
        return this.createResult({
          decision: isAlreadyActive ? "CONTINUE_ACTIVE_CASE" : "SWITCH_EXISTING_CASE",
          ticketId: targetCase.id,
          ticketNumber: targetCase.ticket_number,
          confidence: 0.96,
          evidence: [`P2_ORDINAL_CASE_INDEX_MATCH: index ${ordinalIndex} -> ${targetCase.ticket_number}`],
          reason: `ORDINAL_CASE_INDEX_MATCH: index ${ordinalIndex} -> ${targetCase.ticket_number}`,
        });
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
      return this.createResult({
        decision: isAlreadyActive ? "CONTINUE_ACTIVE_CASE" : "SWITCH_EXISTING_CASE",
        ticketId: slugMatchOpen.id,
        ticketNumber: slugMatchOpen.ticket_number,
        confidence: 0.95,
        evidence: [`P2_SLUG_MATCH: ${slugMatchOpen.ticket_number}`],
        reason: `SLUG_LEGACY_IDENTIFIER_MATCH: ${slugMatchOpen.ticket_number}`,
      });
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
      return this.createResult({
        decision: "CONTINUE_ACTIVE_CASE",
        ticketId: activeCase.id,
        ticketNumber: activeCase.ticket_number,
        confidence: 0.94,
        evidence: ["P3_ACTIVE_CASE_SHORT_AFFIRMATIVE"],
        reason: "ACTIVE_CASE_DEFAULT_SHORT_AFFIRMATIVE",
      });
    }

    // ─────────────────────────────────────────────────────────────
    // P2 / P5 / P6 — Semantic Matching & Evidence Stacking (ISSUE-080)
    // Evaluates subject, title, summary, running_summary, original_problem_statement,
    // and searchable_text across all open and closed cases.
    //
    // Hard Rule (ISSUE-080):
    // OPEN CASE MUST WIN OVER CLOSED CASE SEMANTIC AMBIGUITY.
    // The resolver must NOT route customer actions into a CLOSED ticket merely
    // because the CLOSED ticket has a higher semantic score.
    //
    // Distinguish:
    // referencedTicketId = the case the customer is talking about
    // routingTicketId    = the case to which the new message/action may legally be applied
    // ─────────────────────────────────────────────────────────────
    // "แล้วเรื่อง X ล่ะ" is a switch signal too (2026-09-18): the customer is
    // turning to another subject, so the active case must not win by default.
    const topicShift = hasTopicShiftMarker(text);
    const hasExplicitSwitchWord = /(?:สลับ|เปลี่ยน|กลับไป|ไปที่|ดูเรื่อง|ตามเรื่อง|ขอเรื่อง)/i.test(text) || topicShift;
    const namedTopic = referencedTopic(lowerText);

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

    const matchingOpen = openScores
      .filter((s) => s.score >= 0.45)
      .sort((a, b) => b.score - a.score);

    const matchingClosed = closedScores
      .filter((s) => s.score >= 0.45)
      .sort((a, b) => b.score - a.score);

    // 1. ISSUE-080: Active Open Case Priority
    // If activeCase is set and open, and the message continues or matches context without switch intent:
    // Closed-case semantic similarity must NEVER hijack active open case continuation!
    if (activeCase && !hasExplicitSwitchWord) {
      const activeMatch = openScores.find((s) => s.candidate.id === activeCase.id);
      if (activeMatch && activeMatch.score >= 0.35) {
        return this.createResult({
          decision: "CONTINUE_ACTIVE_CASE",
          ticketId: activeCase.id,
          ticketNumber: activeCase.ticket_number,
          confidence: Math.max(0.88, activeMatch.score),
          evidence: [...activeMatch.evidence, "ISSUE_080_ACTIVE_OPEN_CASE_WINS_OVER_CLOSED_SEMANTICS"],
          reason: "ACTIVE_OPEN_CASE_CONTINUATION_OVER_CLOSED_SEMANTICS",
        });
      }
    }

    // 2. ISSUE-080: Open Case Wins over Closed Case Semantic Ambiguity
    // When OPEN cases match, they take precedence over closed cases.
    if (matchingOpen.length > 0) {
      const topOpen = matchingOpen[0];

      // Check for Ambiguity among competing open cases
      const competingOpen = matchingOpen.filter((s) => s.score >= topOpen.score - 0.15);

      if (competingOpen.length > 1) {
        // Active Case Bias: If active case is one of the competitors AND customer
        // message does NOT have explicit switch intent, bias towards continuing active case.
        if (activeCase && !hasExplicitSwitchWord) {
          const activeCompeting = competingOpen.find((c) => c.candidate.id === activeCase.id);
          if (activeCompeting) {
            return this.createResult({
              decision: "CONTINUE_ACTIVE_CASE",
              ticketId: activeCase.id,
              ticketNumber: activeCase.ticket_number,
              confidence: 0.88,
              evidence: [...activeCompeting.evidence, "ACTIVE_CASE_BIAS_OVER_AMBIGUOUS_MATCH"],
              reason: "ACTIVE_CASE_BIAS_OVER_AMBIGUOUS_MATCH",
            });
          }
        }

        // Return intent (ขอกลับมา / กลับไป / เรื่องเดิม):
        const isReturnIntent = /(?:กลับมา|ขอกลับมา|กลับไป|ขอกลับไป|เรื่องเดิม|เคสเดิม)/i.test(text);
        if (isReturnIntent && recentMessages.length > 0) {
          const recentTicketIds = recentMessages
            .map((m) => Number(m.ticket_id))
            .filter(Boolean);
          const recentCompeting = competingOpen.filter(
            (c) => recentTicketIds.includes(c.candidate.id) && c.candidate.id !== activeTicketId
          );
          if (recentCompeting.length === 1) {
            const target = recentCompeting[0];
            return this.createResult({
              decision: "SWITCH_EXISTING_CASE",
              ticketId: target.candidate.id,
              ticketNumber: target.candidate.ticket_number,
              confidence: 0.92,
              evidence: [...target.evidence, `RETURN_INTENT_RESOLVED_TO_RECENT_CASE: ${target.candidate.ticket_number}`],
              reason: `RETURN_INTENT_RESOLVED_TO_RECENT_CASE: ${target.candidate.ticket_number}`,
            });
          }
        }

        // True Ambiguity among open cases: P6 AMBIGUOUS_CASE
        const candidates = competingOpen.map((m) => m.candidate);
        return this.buildAmbiguityResult(candidates, `AMBIGUOUS_EVIDENCE_BETWEEN_${candidates.length}_OPEN_CASES`);
      }

      // Strong Semantic Match on a single Open Case: OPEN CASE WINS!
      const isAlreadyActive = activeCase && activeCase.id === topOpen.candidate.id;
      return this.createResult({
        decision: isAlreadyActive ? "CONTINUE_ACTIVE_CASE" : "SWITCH_EXISTING_CASE",
        ticketId: topOpen.candidate.id,
        ticketNumber: topOpen.candidate.ticket_number,
        confidence: topOpen.score,
        evidence: [...topOpen.evidence, "ISSUE_080_OPEN_CASE_WINS_OVER_CLOSED_SEMANTICS"],
        reason: `STRONG_OPEN_CASE_SEMANTIC_MATCH: ${topOpen.candidate.ticket_number}`,
      });
    }

    // 3. Only Closed Cases Matched (no open cases matched the text):
    // P5: Closed Case Reference. Decoupled: referencedTicketId = closed.id, routingTicketId = null.
    if (matchingClosed.length > 0 && matchingClosed[0].score >= 0.50) {
      // If activeCase is set and message is conversational continuation without switch words,
      // preserve active open case focus rather than flipping to closed reference.
      if (activeCase && !hasExplicitSwitchWord && this.isShortOrAffirmativeMessage(text)) {
        return this.createResult({
          decision: "CONTINUE_ACTIVE_CASE",
          ticketId: activeCase.id,
          ticketNumber: activeCase.ticket_number,
          confidence: 0.88,
          evidence: ["P3_ACTIVE_CASE_CONTINUATION"],
          reason: "CONTINUE_ACTIVE_CASE_FOCUS",
        });
      }

      const topClosed = matchingClosed[0];
      return this.buildClosedCaseResult(topClosed.candidate, text, openCases, topClosed.evidence);
    }

    // ─────────────────────────────────────────────────────────────
    // P6 — Topic shift that no open case explains
    // "แล้วเรื่องอีเมลล่ะคะ" with several open cases: the customer named a
    // topic while turning away from the current one and nothing above claimed
    // it. Guessing the active case here is what sent a question about one
    // case to the other on 2026-09-18 — ask instead (chips: each case + new).
    // Short replies, images and messages naming no topic never reach this.
    // ─────────────────────────────────────────────────────────────
    if (topicShift && namedTopic && openCases.length > 1) {
      return this.buildAmbiguityResult(openCases, `TOPIC_SHIFT_UNRESOLVED: "${namedTopic}"`);
    }

    // ─────────────────────────────────────────────────────────────
    // P3 — Conversational Continuation of ACTIVE CASE
    // If active case is valid and open, and no explicit switch or stronger match was found,
    // continue the active case (P3).
    // ─────────────────────────────────────────────────────────────
    if (activeCase) {
      return this.createResult({
        decision: "CONTINUE_ACTIVE_CASE",
        ticketId: activeCase.id,
        ticketNumber: activeCase.ticket_number,
        confidence: 0.88,
        evidence: ["P3_ACTIVE_CASE_CONTINUATION"],
        reason: "CONTINUE_ACTIVE_CASE_FOCUS",
      });
    }

    // ─────────────────────────────────────────────────────────────
    // P4 — Recent-Context CASE Resolution
    // If no active case is set, resolve to the most recently discussed open case.
    // Guard: If customer explicitly requested to switch (e.g. "สลับไป...", "เปลี่ยนเรื่อง..."),
    // do NOT silently fall back to recent context of an unrelated case.
    // ─────────────────────────────────────────────────────────────
    if (!hasExplicitSwitchWord && recentMessages.length > 0) {
      const lastMsgWithCase = recentMessages
        .slice()
        .reverse()
        .find((m) => m.ticket_id && openCases.some((c) => c.id === Number(m.ticket_id)));

      if (lastMsgWithCase && lastMsgWithCase.ticket_id) {
        const recentTicketId = Number(lastMsgWithCase.ticket_id);
        const targetRecentCase = openCases.find((c) => c.id === recentTicketId);
        if (targetRecentCase) {
          return this.createResult({
            decision: "SWITCH_EXISTING_CASE",
            ticketId: targetRecentCase.id,
            ticketNumber: targetRecentCase.ticket_number,
            confidence: 0.85,
            evidence: [`P4_RECENT_CONTEXT_CASE: ${targetRecentCase.ticket_number}`],
            reason: `RECENT_CONTEXT_CASE_SWITCH: ${targetRecentCase.ticket_number}`,
          });
        }
      }
    }

    if (openCases.length === 1) {
      return this.createResult({
        decision: "CONTINUE_ACTIVE_CASE",
        ticketId: openCases[0].id,
        ticketNumber: openCases[0].ticket_number,
        confidence: 0.85,
        evidence: ["P3_SINGLE_OPEN_CASE_DEFAULT"],
        reason: "SINGLE_OPEN_CASE_DEFAULT",
      });
    }

    // If multiple open cases exist but no active ticket is set and message has no clear match:
    if (openCases.length > 1) {
      return this.buildAmbiguityResult(openCases, "NO_ACTIVE_TICKET_AMBIGUOUS_FALLTHROUGH");
    }

    // No open cases exist: P7 create a new case
    return this.createResult({
      decision: "NEW_CASE",
      ticketId: null,
      confidence: 0.80,
      evidence: ["P7_NO_OPEN_CASES_NEW_CASE_FALLTHROUGH"],
      initialSubject: text.slice(0, 80),
      reason: "NO_OPEN_CASES_NEW_CASE_FALLTHROUGH",
    });
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

    // 3. Explicit Switch Phrases ("เรื่อง...", "เกี่ยวกับ...", "กลับไป...", "ไปที่...", "ขอกลับมาดูเรื่อง...")
    const cleanText = lowerText.replace(/(?:ครับ|ค่ะ|คับ|นะคะ|นะครับ|หน่อย|ด้วย)$/g, "").trim();
    const switchMatch = cleanText.match(TOPIC_REFERENCE_PATTERN);
    if (switchMatch && switchMatch[1]) {
      // Particles glued to the topic ("ระบบล่ะคะ") are stripped before the
      // comparison; generic words ("ด่วนมาก") never count (2026-09-17/18).
      const rawTopic = normalizeTopic(switchMatch[1]);
      if (
        rawTopic.length >= 2 &&
        (subject.includes(rawTopic) || summary.includes(rawTopic) || running.includes(rawTopic) || searchable.includes(rawTopic))
      ) {
        score += 0.65;
        evidence.push(`EXPLICIT_TOPIC_MATCH: "${rawTopic}"`);
      }
    }

    // 4. Distinctive Domain Terms & Semantic Clusters in Thai & English
    const domainTerms = [
      "ใบแจ้งหนี้", "เข้าไม่ได้", "เข้าใช้งานไม่ได้", "เข้าสู่ระบบ", "ใบเสร็จ", "ยอดเงิน", "ยอดชำระ",
      "ที่อยู่", "แพ็กเกจ", "ราคา", "ภาษี", "เงินยืม", "สลิป", "ล็อกอิน", "รหัสผ่าน",
      "เว็บ", "เว็บไซต์", "website", "web",
      "login", "invoice", "receipt", "billing", "address", "tax", "pricing", "password"
    ];
    for (const term of domainTerms) {
      if (cleanText.includes(term) && (subject.includes(term) || summary.includes(term) || running.includes(term) || searchable.includes(term))) {
        score += 0.50;
        evidence.push(`DOMAIN_TERM_MATCH: "${term}"`);
      }
    }

    // 4.1 Domain Semantic Concept Clusters (e.g. "เข้าไม่ได้" matches "เข้าสู่ระบบ" / "LOGIN")
    const domainClusters = [
      {
        name: "website",
        terms: ["เว็บ", "เว็บไซต์", "website", "web", "เข้าไม่ได้", "เข้าใช้งานไม่ได้"],
      },
      {
        name: "login",
        terms: ["เข้าไม่ได้", "เข้าใช้งานไม่ได้", "เข้าสู่ระบบ", "เข้าระบบ", "ล็อกอิน", "รหัสผ่าน", "login", "password", "sign in", "signin", "auth"],
      },
      {
        name: "tax_invoice",
        terms: ["ใบแจ้งหนี้", "ใบเสร็จ", "ใบกำกับภาษี", "ภาษี", "ยอดเงิน", "ยอดชำระ", "invoice", "receipt", "billing", "tax"],
      },
      {
        name: "pricing",
        terms: ["แพ็กเกจ", "ราคา", "บริการ", "package", "pricing", "price", "plan"],
      },
      {
        name: "shipping_address",
        terms: ["ที่อยู่", "จัดส่ง", "address", "shipping", "delivery"],
      },
      {
        name: "payment",
        terms: ["ชำระเงิน", "จ่ายเงิน", "บัตรเครดิต", "โอนเงิน", "payment", "credit card", "pay"],
      },
    ];

    for (const cluster of domainClusters) {
      const textMatchesCluster = cluster.terms.some((term) => cleanText.includes(term));
      const caseMatchesCluster = cluster.terms.some(
        (term) =>
          subject.includes(term) ||
          summary.includes(term) ||
          running.includes(term) ||
          searchable.includes(term) ||
          category.includes(term)
      );
      if (textMatchesCluster && caseMatchesCluster) {
        score = Math.max(score, 0.52);
        evidence.push(`DOMAIN_CLUSTER_MATCH: "${cluster.name}"`);
        break;
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

    return this.createResult({
      decision: "CLOSED_CASE_REFERENCE",
      ticketId: null, // Hard Invariant: routingTicketId is null
      referencedTicketId: closedCase.id,
      ticketNumber: ticketNum,
      confidence: 0.98,
      evidence: [...evidence, `CLOSED_CASE_PROTECTION: ${ticketNum}`],
      reason: `CLOSED_CASE_PROTECTION: ${ticketNum}`,
      clarificationPrompt: `เคส ${ticketNum} ("${subject}") ได้รับการปิดเรียบร้อยแล้วค่ะ\n\nระบบไม่สามารถเพิ่มข้อมูลลงในเคสที่ปิดแล้วได้ หากท่านต้องการความช่วยเหลือเพิ่มเติม สามารถเลือกเปิดเคสใหม่ได้ทันทีค่ะ`,
      actions,
    });
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

    return this.createResult({
      decision: "AMBIGUOUS_CASE",
      ticketId: null,
      referencedTicketId: null,
      confidence: 0.50,
      evidence: [`AMBIGUOUS_BETWEEN_${candidates.length}_CASES`],
      reason,
      candidates: candidates.map((c) => c.id),
      candidatesDetails: candidates,
      clarificationPrompt: `ได้ค่ะ ตอนนี้มี ${candidates.length} เคสที่กำลังดำเนินการอยู่ ต้องการแจ้งข้อมูลเพิ่มเติมเรื่องไหนคะ?`,
      actions,
    });
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
