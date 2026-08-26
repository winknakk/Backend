/**
 * Recognises a customer's answer to a resolution-confirmation request.
 *
 * Scope is deliberately narrow. This only runs when a ticket is already
 * RESOLVED and is waiting on the customer, so the question being answered is
 * known: "does it work now?". That makes deterministic matching appropriate
 * and safe — there is no need to involve the LLM to close a ticket, and doing
 * so would let customer text drive a state transition.
 *
 * Ambiguity resolves to NONE, never to CONFIRMED. Closing a ticket the
 * customer did not agree to close is the expensive mistake; asking again is
 * cheap.
 */

export type ConfirmationIntent = "CONFIRMED" | "REJECTED" | "NONE";

/**
 * Negation markers. Checked first: "ใช้งานได้แล้ว" and "ยังใช้งานไม่ได้"
 * share most of their characters, so a positive-first match would read the
 * rejection as a confirmation.
 */
const REJECTION_MARKERS = [
  "ยังไม่ได้",
  "ยังใช้ไม่ได้",
  "ยังใช้งานไม่ได้",
  "ไม่ได้อยู่",
  "ยังมีปัญหา",
  "ยังเหมือนเดิม",
  "ยังพัง",
  "ยังไม่หาย",
  "ยังเข้าไม่ได้",
  "ไม่หาย",
  "still not",
  "still broken",
  "still failing",
  "not working",
  "doesn't work",
  "does not work",
  "not fixed",
  "same problem",
  "same issue",
];

const CONFIRMATION_MARKERS = [
  "ใช้งานได้แล้ว",
  "ใช้ได้แล้ว",
  "ได้แล้วครับ",
  "ได้แล้วค่ะ",
  "เรียบร้อยแล้ว",
  "หายแล้ว",
  "ปกติแล้ว",
  "เข้าได้แล้ว",
  "ปิดเคสได้",
  "ปิดเคสได้เลย",
  "ขอบคุณครับ ปิดเคส",
  "it works",
  "working now",
  "works now",
  "resolved",
  "fixed now",
  "all good",
  "you can close",
  "close the case",
  "close it",
];

/** Lowercase and collapse whitespace. Thai has no case, but the English markers need it. */
function normalize(text: string): string {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function detectConfirmationIntent(text: string): ConfirmationIntent {
  const t = normalize(text);
  if (!t) return "NONE";

  // Rejection wins on a tie. "ยังใช้งานไม่ได้ครับ" contains no confirmation
  // marker, but a customer writing "ขอบคุณครับ แต่ยังใช้ไม่ได้" contains
  // both sentiments, and the operative half is the complaint.
  if (REJECTION_MARKERS.some((m) => t.includes(normalize(m)))) return "REJECTED";
  if (CONFIRMATION_MARKERS.some((m) => t.includes(normalize(m)))) return "CONFIRMED";

  return "NONE";
}
