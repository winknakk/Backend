/**
 * Flow 5 post-ticket cancel — deterministic pattern tests (no database).
 *
 * The protocol is two-step: "ยกเลิกเคส [TCK]" only asks, "ยืนยันยกเลิกเคส <TCK>"
 * performs. A bare "ยกเลิก" must never be a cancel request — it already means
 * "abort the draft" (AI gate), "do not close" and "do not reopen" by context.
 */
import assert from "node:assert/strict";
import { detectCancelIntent, detectCloseIntent, CANCEL_TICKET_PATTERN } from "../../src/domain/ticket/CustomerConfirmation";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (err: any) {
    console.error(`❌ ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

check("C-01 'ขอยกเลิกเคส TCK-2026-12345 ค่ะ' is a CANCEL_REQUEST with the number", () => {
  const r = detectCancelIntent("ขอยกเลิกเคส TCK-2026-12345 ค่ะ");
  assert.equal(r.kind, "CANCEL_REQUEST");
  assert.equal(r.ticketNumber, "TCK-2026-12345");
});

check("C-02 'ยกเลิกเคส' without a number is a CANCEL_REQUEST (the handler asks which)", () => {
  assert.equal(detectCancelIntent("ยกเลิกเคส").kind, "CANCEL_REQUEST");
  assert.equal(detectCancelIntent("ยกเลิกตั๋วหน่อยครับ").kind, "CANCEL_REQUEST");
  assert.equal(detectCancelIntent("cancel the ticket").kind, "CANCEL_REQUEST");
  assert.equal(detectCancelIntent("ยกเลิกเคสนี้ค่ะ").kind, "CANCEL_REQUEST");
});

check("C-03 a bare 'ยกเลิก' is NOT a cancel request, with or without a pending cancel question", () => {
  assert.equal(detectCancelIntent("ยกเลิก").kind, "NONE");
  assert.equal(detectCancelIntent("ยกเลิกค่ะ").kind, "NONE");
  assert.equal(detectCancelIntent("ยกเลิก", true).kind, "NONE");
  // …and it still declines a pending close question (unchanged behaviour).
  assert.equal(detectCloseIntent("ยกเลิก", true).kind, "DECLINE_CLOSE");
});

check("C-04 'ยกเลิกเคส TCK-…' is not misread by the close detector", () => {
  assert.equal(detectCloseIntent("ยกเลิกเคส TCK-2026-12345").kind, "NONE");
  assert.equal(detectCloseIntent("ยืนยันยกเลิกเคส TCK-2026-12345", true).kind, "NONE");
});

check("C-05 the confirmation chip performs, with the number, regardless of pending state", () => {
  const r = detectCancelIntent("ยืนยันยกเลิกเคส TCK-2026-12345");
  assert.equal(r.kind, "CONFIRM_CANCEL");
  assert.equal(r.ticketNumber, "TCK-2026-12345");
  assert.equal(detectCancelIntent("ยืนยันการยกเลิกเคสค่ะ").kind, "CONFIRM_CANCEL");
  assert.equal(detectCancelIntent("confirm cancel").kind, "CONFIRM_CANCEL");
});

check("C-06 a bare yes confirms ONLY while the cancel question is pending", () => {
  assert.equal(detectCancelIntent("ยืนยัน").kind, "NONE");
  assert.equal(detectCancelIntent("ใช่ค่ะ").kind, "NONE");
  assert.equal(detectCancelIntent("ยืนยัน", true).kind, "CONFIRM_CANCEL");
  assert.equal(detectCancelIntent("ใช่ค่ะ", true).kind, "CONFIRM_CANCEL");
});

check("C-07 declining works only while pending: 'ไม่ยกเลิก', 'ไม่', 'ยังก่อน'", () => {
  assert.equal(detectCancelIntent("ไม่ยกเลิก", true).kind, "DECLINE_CANCEL");
  assert.equal(detectCancelIntent("ไม่ค่ะ", true).kind, "DECLINE_CANCEL");
  assert.equal(detectCancelIntent("ยังก่อนครับ", true).kind, "DECLINE_CANCEL");
  assert.equal(detectCancelIntent("ไม่ยกเลิก", false).kind, "NONE");
});

check("C-08 a report that merely contains the word stays NONE", () => {
  assert.equal(detectCancelIntent("ระบบยกเลิกใบสั่งซื้อไม่ได้ ขึ้น error 500").kind, "NONE");
  assert.equal(detectCancelIntent("ปุ่มยกเลิกเคสในหน้าจอกดไม่ได้ครับ").kind, "NONE");
  assert.equal(CANCEL_TICKET_PATTERN.test("ยกเลิกเคสไม่ได้ครับ ระบบค้าง"), false);
});

check("C-09 the 'ยกเลิกเคส TCK-…' chip from the which-case list is a request for that case", () => {
  const r = detectCancelIntent("ยกเลิกเคส TCK-2026-00042");
  assert.equal(r.kind, "CANCEL_REQUEST");
  assert.equal(r.ticketNumber, "TCK-2026-00042");
});

console.log(`\n${passed} checks passed${process.exitCode ? ", with failures" : ""}`);
