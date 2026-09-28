/**
 * Real-phrasing corpus for the deterministic cancel/close detectors.
 *
 * Covers the two failures observed in conversation 99961 on 2026-09-18:
 *   - msg 4016 (12:14:13) reached the LLM, which then reported a cancellation
 *     that never happened (tickets#732 stayed untouched until 13:17:35).
 *   - the same bytes again as msg 4022 (13:16:39).
 *
 * The negative half matters more than the positive half: the anchored patterns
 * exist so a problem report mentioning "ปิดเคส" is never read as a command.
 * Clause splitting must not weaken that.
 *
 * Self-contained: no DB, no network.
 */
import assert from "assert";
import {
  detectCancelIntent,
  detectCloseIntent,
  splitCommandClauses,
} from "./domain/ticket/CustomerConfirmation";

const N = "TCK-2026-73046";
let checks = 0;
const fails: string[] = [];

function expectCancel(text: string, kind: string, why: string, pending = false) {
  checks += 1;
  const got = detectCancelIntent(text, pending).kind;
  if (got !== kind) fails.push(`cancel: expected ${kind} got ${got} — "${text}"  [${why}]`);
}
function expectClose(text: string, kind: string, why: string, pending = false) {
  checks += 1;
  const got = detectCloseIntent(text, pending).kind;
  if (got !== kind) fails.push(`close:  expected ${kind} got ${got} — "${text}"  [${why}]`);
}

// --- clause splitting itself -----------------------------------------------
assert.deepEqual(splitCommandClauses(""), [], "empty message yields no clauses");
assert.deepEqual(splitCommandClauses("ปิดเคส"), ["ปิดเคส"], "single clause returns itself only");
assert.ok(
  splitCommandClauses("แอดมินคะ ขอยกเลิกเคสให้หน่อยค่ะ ขอบคุณค่ะ").includes("ขอยกเลิกเคสให้หน่อยค่ะ"),
  "the command clause survives splitting"
);
assert.equal(
  splitCommandClauses("ขอยกเลิกเคส TCK-2026-73046 ให้หน่อยค่ะ")[0],
  "ขอยกเลิกเคส TCK-2026-73046 ให้หน่อยค่ะ",
  "a number with spaces around it is not a clause boundary"
);
checks += 4;

// --- the production regression ---------------------------------------------
const MSG_4016 =
  "แอดมินคะ ขอยกเลิกเคส TCK-2026-73046 ให้หน่อยค่ะ คุยกับเจ้าหน้าที่แล้วไม่ต้องย้อนสถานะแล้วค่ะ";
expectCancel(MSG_4016, "CANCEL_REQUEST", "conversation 99961 msg 4016/4022 — the whole point");
checks += 1;
assert.equal(
  detectCancelIntent(MSG_4016).ticketNumber,
  N,
  "the ticket number must survive clause matching"
);

// --- cancel: real phrasing that must route deterministically ---------------
expectCancel("ขอยกเลิกเคส TCK-2026-73046 ให้หน่อยค่ะ", "CANCEL_REQUEST", "already worked before");
expectCancel("ขอยกเลิกเคสใบเบิกเงินสดย่อยหน่อยนะคะ", "CANCEL_REQUEST", "cancel with subject name without TCK");
expectCancel(
  "แอดมินคะ ขอยกเลิกเคสใบเบิกเงินสดย่อยเมื่อกี้หน่อยนะคะ พอดีเช็กกับพี่การเงินแล้ว ยอดเดินทางตัวที่ซ้ำเขาไปหักลบในรอบถัดไปให้เรียบร้อยแล้วค่ะ หนูเข้าใจผิดไปเอง ขอโทษที่รบกวนนะคะ ขอบคุณมากค่ะ",
  "CANCEL_REQUEST",
  "long cancel with subject and reason"
);
expectCancel("แอดมินคะ ขอยกเลิกเคสหน่อยค่ะ", "CANCEL_REQUEST", "vocative prefix");
expectCancel("สวัสดีค่ะ ขอยกเลิกเคส TCK-2026-73046 ค่ะ", "CANCEL_REQUEST", "greeting prefix");
expectCancel("ยกเลิกเคสให้หน่อยค่ะ ไม่ต้องดำเนินการต่อแล้วค่ะ", "CANCEL_REQUEST", "trailing reason");
expectCancel("ยืนยันยกเลิกเคส TCK-2026-73046", "CONFIRM_CANCEL", "chip text unchanged");
expectCancel("แอดมินคะ ยืนยันยกเลิกเคส TCK-2026-73046 ค่ะ", "CONFIRM_CANCEL", "chip text with vocative");
expectCancel("ดำเนินการต่อ", "DECLINE_CANCEL", "continue button text", true);

// --- cancel: must still NOT fire -------------------------------------------
expectCancel("กดปุ่มยกเลิกเคสไม่ได้ค่ะ", "NONE", "a bug report about the cancel button");
expectCancel("ยกเลิกเคสไม่สำเร็จค่ะ ระบบขึ้น error", "NONE", "a failure report, not a request");
expectCancel("ทำไมเคสถึงถูกยกเลิกคะ", "NONE", "a question about a cancellation");
expectCancel("ยกเลิก", "NONE", "bare ยกเลิก keeps its other three meanings");
expectCancel("ไม่ต้องยกเลิกเคสนะคะ", "NONE", "an explicit refusal is not a request");

// --- cancel: slang / colloquial, no object word (demo 5.3) -------------------
// SOFT only: the handler honours it when no question is pending and a case is open.
const SOFT = "SOFT_CANCEL_REQUEST";
[
  // the demo script
  "ไม่ต้องดูแล้วจ้า",
  "ทำได้ละจ้า",
  "กดยกเลิกให้ที",
  "ไม่ต้องดูแล้วนะ ทำได้ละ",
  // no longer needed
  "ไม่ต้องดูแล้วค่ะ",
  "ไม่ต้องแล้วครับ",
  "ไม่ต้องละจ้า",
  "ไม่ต้องทำต่อแล้วนะคะ",
  "ไม่ต้องแก้แล้วค่ะ",
  "ไม่ต้องตามแล้วครับ",
  "ไม่ต้องเช็คแล้วน้า",
  "ไม่ต้องส่งช่างแล้วค่ะ",
  "ไม่ต้องดำเนินการแล้วค่ะ",
  "ไม่ต้องดูเรื่องเงินยืมแล้วนะคะ",
  "ไม่ต้องดูเคสนี้แล้วค่ะ",
  "ไม่ต้องดูก็ได้ค่ะ",
  "ไม่เอาแล้วค่ะ",
  "ไม่ต้องการแล้วครับ",
  "ไม่จำเป็นต้องแก้แล้วค่ะ",
  "ไม่รบกวนแล้วค่ะ ขอบคุณค่ะ",
  "ไม่เป็นไรแล้วค่ะ",
  "ไม่มีปัญหาแล้วค่ะ",
  // solved it themselves
  "ทำได้แล้วค่ะ",
  "ทำได้ละ",
  "แก้ได้แล้วค่ะ",
  "แก้ได้เองแล้วค่ะ",
  "แก้เองได้แล้วครับ",
  "แก้เองแล้วค่ะ ขอบคุณนะคะ",
  "จัดการเองได้แล้วค่ะ",
  "เคลียร์ได้แล้วครับ",
  "หายเองแล้วค่ะ",
  "ปัญหาหายเองค่ะ",
  "อ๋อ ทำได้แล้วค่ะ ขอโทษที่รบกวนนะคะ",
  "โอเคค่ะ แก้ได้เองแล้ว ขอบคุณมากค่ะ 🙏",
  "ทำได้ละจ้าาา 555",
  // cancel without the object word
  "ยกเลิกให้ทีค่ะ",
  "ยกเลิกให้หน่อยครับ",
  "ช่วยยกเลิกให้หน่อยค่ะ",
  "รบกวนยกเลิกให้ด้วยค่ะ",
  "ยกเลิกเลยค่ะ",
  "ยกเลิกไปเลยครับ",
  "ยกเลิกได้เลยค่ะ",
  "ยกเลิกทิ้งเลย",
  "ขอยกเลิกค่ะ",
  "อยากยกเลิกครับ",
  "ยกเลิกเรื่องนี้ให้หน่อยค่ะ",
  "ช่วยยกเลิกเรื่องเงินยืมให้หน่อยค่ะ",
  "ขอยกเลิกเรื่องเงินยืมค่ะ",
  "แอดมินคะ กดยกเลิกให้หน่อยค่ะ",
  "ยกเลิกเถอะค่ะ",
  // let it go
  "ช่างมันเถอะค่ะ",
  "ปล่อยไปเลยครับ",
  "ลืมเรื่องนี้ไปได้เลยค่ะ",
  "เลิกดูได้เลยค่ะ",
  "ถอนเรื่องค่ะ",
  // English
  "never mind",
  "nvm thanks",
  "I fixed it myself",
  "please cancel it",
  "no longer needed",
  // with a number
  `ไม่ต้องดูแล้วค่ะ ${N}`,
].forEach((t) => expectCancel(t, SOFT, "slang cancel"));

// Not a cancel — something is left over, or it is negated / a report / a bare word.
[
  "ยกเลิก",
  "ไม่ต้อง",
  "ไม่เป็นไรค่ะ",
  "ขอบคุณค่ะ",
  "โอเคค่ะ",
  "ได้แล้วค่ะ",
  "ใช้งานได้แล้วค่ะ",
  "ทำได้ละ แต่ยังช้าอยู่นิดนึง",
  "ไม่ต้องดูแล้ว ยังเข้าไม่ได้เลย",
  "ยังทำไม่ได้เลยค่ะ",
  "ทำไม่ได้ค่ะ",
  "แก้ไม่ได้ครับ",
  "ไม่ต้องรีบนะคะ",
  "ไม่ต้องยกเลิกนะคะ",
  "อย่าเพิ่งยกเลิกนะ",
  "กดยกเลิกไม่ได้ค่ะ",
  "ยกเลิกไปแล้ว",
  "ยกเลิกไม่ได้ค่ะ ขึ้น error",
  "ทำไมถูกยกเลิก",
  "ระบบเบิกรถยนต์ กดบันทึกแล้วหมุนค้าง",
  "ลืมรหัสผ่านค่ะ",
].forEach((t) => expectCancel(t, "NONE", "not a slang cancel"));
// A pending cancel question: the explicit decline still wins over slang.
expectCancel("ไม่ยกเลิกแล้วค่ะ", "DECLINE_CANCEL", "decline beats slang while the cancel question is out", true);

// --- close: real phrasing ---------------------------------------------------
expectClose("แอดมินคะ ขอปิดเคส TCK-2026-73046 ให้หน่อยค่ะ", "CLOSE_REQUEST", "vocative prefix");
expectClose("ปิดเคสให้หน่อยค่ะ ใช้งานได้ปกติแล้วค่ะ", "CLOSE_REQUEST", "trailing reason");
expectClose("แอดมินคะ ยืนยันปิดเคส TCK-2026-73046 ค่ะ", "CONFIRM_CLOSE", "chip text with vocative");

// --- close: the negatives the anchor exists to protect ----------------------
expectClose("ปิดเคสไม่ได้ครับ ระบบขึ้น error", "NONE", "RE-ASSERTED: report mentioning close");
expectClose("ทำไมเคสยังไม่ปิด", "NONE", "RE-ASSERTED: a question");
expectClose("กดปิดเคสแล้วเด้งออกเลยค่ะ ใช้ไม่ได้ค่ะ", "NONE", "report whose first clause has ปิดเคส mid-sentence");
expectClose("ระบบปิดเคสเองอัตโนมัติค่ะ ทั้งที่ยังไม่หายค่ะ", "NONE", "complaint about auto-close");

console.log(`\nคำสั่งที่คนพิมพ์จริง — ${checks} เช็ค`);
if (fails.length) {
  console.log(`\nพลาด ${fails.length} ข้อ:`);
  fails.forEach((f) => console.log("  " + f));
  process.exit(1);
}
console.log("ผ่านทั้งหมด");
