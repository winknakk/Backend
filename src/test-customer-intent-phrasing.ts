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
expectCancel("แอดมินคะ ขอยกเลิกเคสหน่อยค่ะ", "CANCEL_REQUEST", "vocative prefix");
expectCancel("สวัสดีค่ะ ขอยกเลิกเคส TCK-2026-73046 ค่ะ", "CANCEL_REQUEST", "greeting prefix");
expectCancel("ยกเลิกเคสให้หน่อยค่ะ ไม่ต้องดำเนินการต่อแล้วค่ะ", "CANCEL_REQUEST", "trailing reason");
expectCancel("ยืนยันยกเลิกเคส TCK-2026-73046", "CONFIRM_CANCEL", "chip text unchanged");
expectCancel("แอดมินคะ ยืนยันยกเลิกเคส TCK-2026-73046 ค่ะ", "CONFIRM_CANCEL", "chip text with vocative");

// --- cancel: must still NOT fire -------------------------------------------
expectCancel("กดปุ่มยกเลิกเคสไม่ได้ค่ะ", "NONE", "a bug report about the cancel button");
expectCancel("ยกเลิกเคสไม่สำเร็จค่ะ ระบบขึ้น error", "NONE", "a failure report, not a request");
expectCancel("ทำไมเคสถึงถูกยกเลิกคะ", "NONE", "a question about a cancellation");
expectCancel("ยกเลิก", "NONE", "bare ยกเลิก keeps its other three meanings");
expectCancel("ไม่ต้องยกเลิกเคสนะคะ", "NONE", "an explicit refusal is not a request");

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
