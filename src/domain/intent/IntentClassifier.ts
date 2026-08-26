/**
 * Deterministic intent classification for inbound customer messages.
 *
 * Replaces the substring matcher in AgentRuntime, which opened a ticket for
 * any message containing "bug", "crash", "error 5" and so on. Measured
 * false-positive rate on a probe set of non-incidents: 9 of 9.
 *
 * The failure was not an incomplete keyword list, so the fix is not a longer
 * one. A message becomes an incident because of what it ASSERTS, not because
 * of which words it contains:
 *
 *   "Can you send the Bugatti invoice?"        contains "bug", asserts nothing
 *   "How do I debug my own integration?"       asks how to do something
 *   "ขอบคุณครับ ไม่มีอะไรพังแล้ว ใช้งานได้ปกติ"  contains "พัง", asserts the opposite
 *   "เมื่อวานระบบล่มใช่ไหม ตอนนี้ปกติแล้วใช่ไหม"  asks about the past
 *   "ระบบเข้าไม่ได้ครับ"                        asserts a present failure
 *
 * So the pipeline evaluates, in order: is the customer answering a question we
 * asked, are they saying the problem is GONE, are they asking rather than
 * reporting, and only then — are they describing a present technical symptom.
 *
 * Deliberately rule-based and self-contained. This decides whether to create a
 * ticket and, via CustomerConfirmation, whether to close one. Neither decision
 * is delegated to an LLM, because customer-authored text must not be able to
 * drive a state transition.
 */

import { detectConfirmationIntent } from "../ticket/CustomerConfirmation";

export type MessageIntent =
  | "TECHNICAL_INCIDENT"
  | "STATUS_QUERY"
  | "CUSTOMER_CONFIRMATION"
  | "GENERAL_INQUIRY"
  | "NON_INCIDENT";

export interface ClassificationContext {
  /** True when a ticket on this conversation is RESOLVED and awaiting the customer. */
  hasTicketAwaitingConfirmation?: boolean;
  /** True when this conversation already has an open ticket. */
  hasOpenTicket?: boolean;
}

export interface Classification {
  intent: MessageIntent;
  /** Whether a new ticket should be created for this message. */
  shouldCreateTicket: boolean;
  /** The rule that decided it, for the audit trail and for debugging. */
  rule: string;
  signals: Signals;
}

interface Signals {
  isQuestion: boolean;
  isHowTo: boolean;
  isFeatureRequest: boolean;
  isHistorical: boolean;
  assertsWorking: boolean;
  negatesProblem: boolean;
  hasSymptom: boolean;
  /** True when the only evidence is a weak term like "bug" or "error". */
  weakEvidenceOnly: boolean;
  symptomTerms: string[];
  isStatusQuery: boolean;
  isMetaDiscussion: boolean;
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

/**
 * English terms are matched on word boundaries; Thai has no inter-word spaces
 * so its terms are matched as substrings, which is safe because the Thai terms
 * used here are distinctive multi-character phrases.
 *
 * The boundary rule is what stops "Bugatti", "Bugsy" and "Debugger" matching
 * "bug" — the defect that made the previous classifier unusable.
 */
function hasWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`, "i").test(text);
}

function hasAny(text: string, phrases: string[]): boolean {
  return phrases.some((p) => (/[a-z]/i.test(p) && !/[฀-๿]/.test(p) ? hasWord(text, p) : text.includes(p)));
}

function normalize(text: string): string {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Signal extraction
// ---------------------------------------------------------------------------

/** A present, first-hand technical failure. Error codes count on their own. */
const SYMPTOM_PHRASES = [
  // Thai — present-tense inability or failure
  "เข้าไม่ได้",
  "เข้าใช้งานไม่ได้",
  "ใช้งานไม่ได้",
  "ใช้ไม่ได้",
  "ไม่สามารถ",
  "ล่ม",
  "ค้าง",
  "ช้ามาก",
  "ขึ้น error",
  "ระบบมีปัญหา",
  "โหลดไม่ขึ้น",
  "กดไม่ได้",
  "ล็อกอินไม่ได้",
  "ล็อกอินไม่ผ่าน",
  // English — symptom words, matched on word boundaries
  "crash",
  "crashed",
  "crashes",
  "crashing",
  "timeout",
  "timing out",
  "unresponsive",
  "not loading",
  "cannot access",
  "can't access",
  "unable to",
  "not working",
  "stopped working",
  "keeps failing",
];

/** HTTP-style error codes: a bare 4xx/5xx is a symptom regardless of phrasing. */
const ERROR_CODE = /\b[45]\d{2}\b/;

/** "พัง" and "bug" only count alongside something that makes them a report. */
const WEAK_SYMPTOM_TERMS = ["พัง", "bug", "error", "fatal", "down", "broken"];

const QUESTION_MARKERS = [
  "?",
  "ใช่ไหม",
  "ใช่มั้ย",
  "หรือเปล่า",
  "รึเปล่า",
  "หรือไม่",
  "ไหมครับ",
  "ไหมคะ",
  "อย่างไร",
  "ยังไง",
  "เมื่อไหร่",
  "ทำไม",
];

const HOWTO_MARKERS = [
  "how do i",
  "how to",
  "how can i",
  "can you explain",
  "explaining",
  "วิธี",
  "ทำยังไง",
  "ทำอย่างไร",
  "สอน",
];

const FEATURE_REQUEST_MARKERS = [
  "please add",
  "roadmap",
  "feature request",
  "would be nice",
  "suggestion",
  "อยากให้เพิ่ม",
  "ขอฟีเจอร์",
  "เสนอแนะ",
];

const HISTORICAL_MARKERS = [
  "yesterday",
  "last week",
  "last night",
  "เมื่อวาน",
  "เมื่อวานนี้",
  "อาทิตย์ที่แล้ว",
  "ที่ผ่านมา",
  "เมื่อกี้",
];

/** The customer stating things are fine — the inverse of a symptom. */
const WORKING_MARKERS = [
  "ใช้งานได้",
  "ใช้ได้แล้ว",
  "ปกติแล้ว",
  "หายแล้ว",
  "เรียบร้อยแล้ว",
  "เข้าได้แล้ว",
  "works fine",
  "working now",
  "works now",
  "all good",
  "no longer an issue",
];

/** Explicit negation of a problem: "nothing is broken". */
const NEGATED_PROBLEM_MARKERS = [
  "ไม่มีอะไรพัง",
  "ไม่มีปัญหา",
  "ไม่ได้พัง",
  "ไม่มีอะไรเสีย",
  "nothing is broken",
  "nothing broken",
  "no problem",
  "no issues",
  "not broken",
];

/**
 * The message is ABOUT written material rather than about the customer's own
 * experience — "our deck mentions 'crash recovery'". The symptom word is
 * being cited, not reported, and citing one must not open a ticket.
 */
const META_DISCUSSION_MARKERS = [
  "mentions",
  "mentioned",
  "documentation",
  "docs",
  "article",
  "deck",
  "slide",
  "guide",
  "manual",
  "glossary",
  "handbook",
  "training material",
  "wording",
  "เอกสาร",
  "สไลด์",
  "คู่มือ",
  "บทความ",
];

const STATUS_QUERY_MARKERS = [
  "สถานะ",
  "ถึงไหน",
  "คืบหน้า",
  "อัพเดท",
  "อัปเดต",
  "ticket status",
  "case status",
  "any update",
  "progress",
];

function extractSignals(text: string): Signals {
  const t = normalize(text);

  // A term inside quotes is being cited, not reported. Symptom detection runs
  // against the unquoted remainder so that
  // "our deck mentions 'crash recovery'" contributes no symptom.
  const unquoted = t.replace(/["'‘’“”«»]([^"'‘’“”«»]{1,80})["'‘’“”«»]/g, " ");

  const symptomTerms: string[] = [];
  for (const phrase of SYMPTOM_PHRASES) {
    const isThai = /[฀-๿]/.test(phrase);
    if (isThai ? unquoted.includes(phrase) : hasWord(unquoted, phrase.replace(/\s+/g, "\\s+"))) {
      symptomTerms.push(phrase);
    }
  }
  const hasErrorCode = ERROR_CODE.test(unquoted);
  if (hasErrorCode) symptomTerms.push("error-code");

  const weakTerms = WEAK_SYMPTOM_TERMS.filter((w) =>
    /[฀-๿]/.test(w) ? unquoted.includes(w) : hasWord(unquoted, w)
  );

  const assertsWorking = hasAny(t, WORKING_MARKERS);
  const negatesProblem = hasAny(t, NEGATED_PROBLEM_MARKERS);

  // A weak term only becomes a symptom when nothing contradicts it and it is
  // not merely being discussed. "I found a bug" reports one; "add a Debugger
  // panel" does not, and "ไม่มีอะไรพัง" says the opposite.
  const weakCountsAsSymptom = weakTerms.length > 0 && !assertsWorking && !negatesProblem;

  return {
    weakEvidenceOnly: symptomTerms.length === 0 && weakCountsAsSymptom,
    isQuestion: hasAny(t, QUESTION_MARKERS),
    isHowTo: hasAny(t, HOWTO_MARKERS),
    isFeatureRequest: hasAny(t, FEATURE_REQUEST_MARKERS),
    isHistorical: hasAny(t, HISTORICAL_MARKERS),
    assertsWorking,
    negatesProblem,
    hasSymptom: symptomTerms.length > 0 || weakCountsAsSymptom,
    symptomTerms: symptomTerms.length > 0 ? symptomTerms : weakTerms,
    isStatusQuery: hasAny(t, STATUS_QUERY_MARKERS),
    isMetaDiscussion: hasAny(t, META_DISCUSSION_MARKERS),
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function classifyMessage(text: string, context: ClassificationContext = {}): Classification {
  const signals = extractSignals(text);
  const decide = (intent: MessageIntent, rule: string, shouldCreateTicket: boolean): Classification => ({
    intent,
    rule,
    shouldCreateTicket,
    signals,
  });

  if (!normalize(text)) {
    return decide("NON_INCIDENT", "empty-message", false);
  }

  // 1. Answering a question we asked. Checked first: while a ticket is
  //    RESOLVED, "ยังใช้ไม่ได้" is a rejection of that fix, not a new incident.
  if (context.hasTicketAwaitingConfirmation) {
    const confirmation = detectConfirmationIntent(text);
    if (confirmation !== "NONE") {
      return decide("CUSTOMER_CONFIRMATION", `confirmation-${confirmation.toLowerCase()}`, false);
    }
  }

  // 2. The customer says the problem is gone. This must precede symptom
  //    detection, because such messages usually name the problem in order to
  //    say it no longer exists.
  if (signals.negatesProblem || (signals.assertsWorking && !signals.isQuestion)) {
    return decide("NON_INCIDENT", "asserts-resolved", false);
  }

  // 3. Asking about an existing case rather than reporting a new one.
  if (signals.isStatusQuery) {
    return decide("STATUS_QUERY", "status-query", false);
  }

  // 4. Asking about the past. "เมื่อวานระบบล่มใช่ไหม" discusses an outage; it
  //    does not report one now.
  if (signals.isHistorical && signals.isQuestion) {
    return decide("STATUS_QUERY", "historical-question", false);
  }

  // 5. Asking how to do something. The subject is the customer's own work,
  //    not a failure of ours — "How do I debug my own integration?".
  if (signals.isHowTo) {
    return decide("GENERAL_INQUIRY", "how-to-question", false);
  }

  // 6. Asking for a feature.
  if (signals.isFeatureRequest) {
    return decide("GENERAL_INQUIRY", "feature-request", false);
  }

  // 7. Discussing written material rather than reporting an experience.
  if (signals.isMetaDiscussion) {
    return decide("GENERAL_INQUIRY", "meta-discussion", false);
  }

  // 8. Weak evidence inside a question is not an assertion.
  //
  //    "There is a bug in my garden, is that covered by your pest module?"
  //    contains "bug" and nothing else technical, and it ASKS rather than
  //    reports. A strong symptom or an error code still counts here, so
  //    "ทำไมระบบเข้าไม่ได้ครับ" and "Getting error 500?" remain incidents.
  if (signals.hasSymptom && signals.weakEvidenceOnly && signals.isQuestion) {
    return decide("GENERAL_INQUIRY", "weak-evidence-question", false);
  }

  // 9. A present technical symptom. A question can still be an incident
  //    ("ทำไมระบบเข้าไม่ได้") — what disqualifies it is asking how to do
  //    something or asking about the past, both already handled above.
  if (signals.hasSymptom) {
    return decide("TECHNICAL_INCIDENT", `symptom:${signals.symptomTerms.slice(0, 3).join(",")}`, true);
  }

  // 10. Anything else. Never a ticket: silence is cheaper than a false one.
  return decide("GENERAL_INQUIRY", "no-symptom", false);
}

/** Convenience wrapper for the ticket-creation decision. */
export function shouldCreateTicket(text: string, context: ClassificationContext = {}): boolean {
  return classifyMessage(text, context).shouldCreateTicket;
}
