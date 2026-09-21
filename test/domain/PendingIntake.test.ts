/**
 * Pending intake on LINE (2026-09-17): the pure rules that keep the edge case
 * resolver out of a draft the AI gate is still confirming. The texts are the
 * ones seen live in conversation 99961 (messages 3877–3885).
 */
import assert from "node:assert/strict";
import { hasExplicitCaseReference, isPendingCreatePrompt, pendingIntakeKind, shouldDeferToPendingIntake } from "../../src/domain/case/PendingIntake";

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

const CONFIRM_CARD =
  "รับทราบค่ะ แอดมินขอสรุปรายละเอียดก่อนนะคะ ลูกค้าแจ้งว่าไม่สามารถใช้งานเว็บไซต์ได้ เนื่องจากระบบแสดงข้อความ 4410 Gone ทุกเมนูและทุกแพลตฟอร์ม เป็นเรื่องด่วนมาก\nหากข้อมูลครบถ้วนแล้ว กดปุ่ม 'ยืนยัน' ด้านล่างได้เลยค่ะ หรือส่งรายละเอียดเพิ่มเติมเข้ามาได้เลยนะคะ";
const EDIT_QUESTION =
  "ได้เลยค่ะ ต้องการแก้ไขส่วนไหนคะ ชื่อระบบ อาการ หรือรายละเอียด พิมพ์บอกแอดมินได้เลยนะคะ\nแก้ไขแล้วแอดมินจะสรุปให้ยืนยันอีกครั้งนะคะ";
const CLOSED_PROTECTION =
  'เคส TCK-2026-83960 ("ระบบเว็บไซต์ - ข้อความแสดงข้อผิดพลาด 401 Unauthorized เข้าใช้งานไม่ได้") ได้รับการปิดเรียบร้อยแล้วค่ะ\n\nระบบไม่สามารถเพิ่มข้อมูลลงในเคสที่ปิดแล้วได้ หากท่านต้องการความช่วยเหลือเพิ่มเติม สามารถเลือกเปิดเคสใหม่ได้ทันทีค่ะ';
const TICKET_CARD = "เคส TCK-2026-86186\n\n• เรื่อง: ระบบเว็บไซต์ - เข้าใช้งานไม่ได้ และเป็นเคสด่วนมาก\n• สถานะ: รับเรื่องแล้ว\n• แจ้งเมื่อ: 17/09/69 เวลา 15:17 น.";
const CLOSE_QUESTION = "ต้องการปิดเคส TCK-2026-45367 ใช่ไหมคะ";
const CORRECTION = "ขอแก้อาการเป็น เข้าใช้งานไม่ได้เลย และเป็นเคสด่วนมากครับ";

check("P-01 the summary card is a pending 'confirm'", () => {
  assert.equal(pendingIntakeKind(CONFIRM_CARD), "confirm");
  assert.equal(isPendingCreatePrompt(CONFIRM_CARD), true);
});

check("P-02 the 'which part to change?' question is a pending 'edit'", () => {
  assert.equal(pendingIntakeKind(EDIT_QUESTION), "edit");
});

check("P-03 protection, case card, close question and empty are not pending intake", () => {
  assert.equal(pendingIntakeKind(CLOSED_PROTECTION), null);
  assert.equal(pendingIntakeKind(TICKET_CARD), null);
  assert.equal(pendingIntakeKind(CLOSE_QUESTION), null);
  assert.equal(pendingIntakeKind(""), null);
  assert.equal(pendingIntakeKind(null), null);
});

check("P-04 the live correction defers to the draft after the edit question", () => {
  assert.equal(shouldDeferToPendingIntake(CORRECTION, EDIT_QUESTION), "edit");
  assert.equal(shouldDeferToPendingIntake("ขอแก้ไขข้อมูล", CONFIRM_CARD), "confirm");
  assert.equal(shouldDeferToPendingIntake("ยืนยัน", CONFIRM_CARD), "confirm");
  assert.equal(shouldDeferToPendingIntake("ยกเลิก", EDIT_QUESTION), "edit");
});

check("P-05 a TCK number or an explicit new-case command still resolves normally", () => {
  assert.equal(hasExplicitCaseReference("เรื่อง TCK-2026-83960 ที่ปิดไปแล้ว ตอนนี้เจออีก"), true);
  assert.equal(hasExplicitCaseReference("เปิดเคสใหม่"), true);
  assert.equal(hasExplicitCaseReference("เปิดเคสใหม่: ติดตามต่อจาก TCK-2026-83960"), true);
  assert.equal(hasExplicitCaseReference(CORRECTION), false);
  assert.equal(hasExplicitCaseReference("ยืนยัน"), false);
  assert.equal(shouldDeferToPendingIntake("สลับไปที่ TCK-2026-86186", CONFIRM_CARD), null);
  assert.equal(shouldDeferToPendingIntake("เปิดเคสใหม่", EDIT_QUESTION), null);
});

check("P-06 nothing pending → never defers", () => {
  assert.equal(shouldDeferToPendingIntake(CORRECTION, CLOSED_PROTECTION), null);
  assert.equal(shouldDeferToPendingIntake(CORRECTION, null), null);
});

console.log(`\n${passed} checks passed${process.exitCode ? ", with failures" : ""}`);
