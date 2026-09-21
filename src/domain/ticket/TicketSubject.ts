/**
 * Guards the one field a ticket cannot be useful without: what the problem is.
 *
 * The intake path can reach ticket creation carrying the customer's *trigger*
 * rather than their *report*. When the customer taps "เปิดเคสใหม่", that text
 * is the whole message, and an intake draft built from the latest message
 * summarises it as "เปิดเคสใหม่" — which then becomes the subject, is
 * confirmed, is filed, and syncs to Plane as an empty case.
 *
 * Runtime evidence (conversation 99961, 2026-09-18):
 *   14:08:19 customer  "เปิดเคสใหม่"
 *   14:11:18 ai        "แอดมินสรุปเรื่องที่แจ้งมาได้ดังนี้ค่ะ เปิดเคสใหม่"
 *   14:12:14 customer  "ยืนยัน"
 *   14:15:30 tickets#746 TCK-2026-81490 subject="เปิดเคสใหม่" status=TRIAGED
 *
 * The check lives here, in the domain, rather than in the flow, because the
 * deployed flow set is UNKNOWN (.ai/FLOWS.md, 2026-09-03) and the backend is
 * the only layer that can be relied on to refuse.
 *
 * Deliberately narrow: it rejects a subject that is *nothing but* a command,
 * after politeness and punctuation are stripped. A real report that merely
 * starts with one ("เปิดเคสใหม่ ปริ้นใบเสร็จไม่ออก") carries the problem and
 * is accepted — the goal is to catch the empty case, not to police wording.
 */

/**
 * Phrases that start, route, or confirm an intake but never describe a problem.
 * Kept as literal phrases rather than a loose regex so that widening the list
 * cannot accidentally start swallowing real reports.
 */
const COMMAND_ONLY_SUBJECTS: readonly string[] = [
  // P0 new-case triggers (mirrors the anchored list in CaseResolver)
  "แจ้งปัญหาใหม่",
  "เปิดเคสใหม่",
  "เปิดตั๋วใหม่",
  "สร้างเคสใหม่",
  "แจ้งอีกเรื่อง",
  "มีอีกหนึ่งปัญหา",
  "มีอีกปัญหา",
  "เรื่องใหม่",
  "ปัญหาใหม่",
  "เคสใหม่",
  "report_issue",
  "new_case",
  // Bare intake openers
  "เปิดเคส",
  "แจ้งปัญหา",
  "แจ้งเรื่อง",
  "ขอเปิดเคส",
  "ขอแจ้งปัญหา",
  "สอบถาม",
  "ขอสอบถาม",
  // Navigation and protocol chips that must never become a case
  "ดูเคสล่าสุดทั้งหมด",
  "ดูเคสล่าสุด",
  "ตรวจสอบสถานะ",
  "เช็คสถานะ",
  "ยืนยัน",
  "ยกเลิก",
  "ปิดเคส",
  "ยกเลิกเคส",
  "ใช้งานได้แล้ว",
  "ยังมีปัญหาอยู่",
  "ปัญหาเดิม",
];

/**
 * Zero-width and byte-order marks, which LINE chip text can carry and which no
 * amount of visual inspection would reveal. Built from a string rather than a
 * regex literal so this source file contains no invisible characters of its own.
 * `\s` already covers NBSP, tabs, and newlines.
 */
const INVISIBLE = new RegExp("[\\u200B-\\u200D\\uFEFF]", "g");

/** Politeness, punctuation, and chip decoration that carry no meaning here. */
const NOISE =
  /[\s+/\-_.,!?ๆฯ"'`()[\]{}]|—|–|นะครับ|นะคะ|ครับผม|ค้าบ|คร้าบ|ครับ|ค่ะ|คะ|คับ|จ้า|จ้ะ|งับ|ฮะ|ฮับ|ค่า|หน่อย|ด้วย|เลย|ที|นะ|น่ะ/g;

function normalize(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(INVISIBLE, "")
    .replace(NOISE, "");
}

const NORMALIZED_COMMANDS = new Set(COMMAND_ONLY_SUBJECTS.map(normalize));

/**
 * True when the subject carries a command and no problem description.
 *
 * Also true for an empty or punctuation-only subject: a ticket with nothing in
 * its subject is the same defect arriving by a different route.
 */
export function isCommandOnlySubject(subject: string | null | undefined): boolean {
  const normalized = normalize(subject ?? "");
  if (!normalized) return true;
  return NORMALIZED_COMMANDS.has(normalized);
}

/** What to tell the caller — the agent reads this and must ask the customer. */
export const COMMAND_ONLY_SUBJECT_ERROR =
  "SUBJECT_IS_COMMAND_NOT_PROBLEM: the subject repeats the customer's trigger phrase and contains no problem description. " +
  "Ask the customer what the problem is, then create the ticket with their answer as the subject.";
