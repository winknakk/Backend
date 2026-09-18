/**
 * Pending intake (two-step ticket confirmation) — the pure rules the LINE
 * edge shares with the AI gate.
 *
 * The Main AI Core flow decides whether it is still waiting for the customer
 * to confirm a draft by looking at the bot's LAST real reply (its
 * `isAwaitingConfirmation` net in `step_parse_gate`). While that is the case,
 * every text turn — "ยืนยัน", the "ขอแก้ไขข้อมูล" chip, the correction that
 * follows the "ต้องการแก้ไขส่วนไหน" question — belongs to the draft, not to
 * any existing case. The backend must read the same state the same way,
 * otherwise the edge case resolver hijacks the turn (seen live 2026-09-17:
 * a correction "ขอแก้อาการเป็น เข้าใช้งานไม่ได้เลย และเป็นเคสด่วนมากครับ"
 * was answered with the closed-case protection for an old ticket).
 *
 * Keep the markers in step with the flow's `isAwaitingConfirmation` regex and
 * the prompt's mandatory closing sentence for EDIT_REQUESTED.
 */

export type PendingIntakeKind = "confirm" | "edit";

/** The bot's reply to the "ขอแก้ไขข้อมูล" chip — asks which part to change. */
const EDIT_QUESTION_PATTERN = /ต้องการแก้ไขส่วนไหน|สรุปให้ยืนยันอีกครั้ง/;

/** The create-confirmation card (summary + "press ยืนยัน"). */
const CONFIRM_CARD_PATTERN =
  /ยืนยันให้เปิดเคส|ข้อมูลถูกต้องหรือไม่|ขอทวนให้ชัวร์|ขอทวนก่อนนะ|ขอทวน|ยืนยันได้เลยไหม|ยืนยันได้เลยนะ|ยืนยันเพื่อเปิดเคส|CONFIRM_CREATE_PENDING|พิมพ์\s*['"]ยืนยัน['"]|สรุปรายละเอียดก่อน|ยืนยันให้เปิด|ข้อมูลถูกต้องไหม|ถูกต้องหรือเปล่า|กดปุ่ม\s*['"]ยืนยัน['"]|ปุ่มด้านล่าง|สรุปเรื่องที่แจ้งมา/;

/**
 * What the bot's last real reply is waiting for: `confirm` (the summary card),
 * `edit` (the "which part to change?" question), or null.
 */
export function pendingIntakeKind(lastAiContent: string | null | undefined): PendingIntakeKind | null {
  const content = String(lastAiContent || "");
  if (!content) return null;
  if (EDIT_QUESTION_PATTERN.test(content)) return "edit";
  if (CONFIRM_CARD_PATTERN.test(content)) return "confirm";
  return null;
}

/** True when the bot's last real reply is any pending-intake question. */
export function isPendingCreatePrompt(lastAiContent: string | null | undefined): boolean {
  return pendingIntakeKind(lastAiContent) !== null;
}

/**
 * A turn that names a case outright, or asks for a new one outright, is
 * about that — even mid-intake. Everything else during a pending intake is
 * left to the AI gate.
 */
export function hasExplicitCaseReference(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/TCK-\d{4}-\d{4,6}/i.test(t)) return true;
  return /^(?:\+\s*)?(?:แจ้งปัญหาใหม่|เปิดเคสใหม่|เปิดตั๋วใหม่|สร้างเคสใหม่|report_issue|new_case)/i.test(t);
}

/**
 * Whether the edge case resolver must stand down for this turn: the bot is
 * waiting on a draft and the customer did not name a case or ask for a new one.
 */
export function shouldDeferToPendingIntake(text: string, lastAiContent: string | null | undefined): PendingIntakeKind | null {
  const kind = pendingIntakeKind(lastAiContent);
  if (!kind) return null;
  return hasExplicitCaseReference(text) ? null : kind;
}
