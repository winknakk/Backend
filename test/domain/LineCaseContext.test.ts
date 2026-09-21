/**
 * Flow 6 on LINE — the pure parts of LineCaseContextService (no database):
 * the hint handed to the AI gate, the chips, and the "pure switch command"
 * rule that decides whether the AI turn is skipped.
 */
import assert from "node:assert/strict";
import { CaseResolver } from "../../src/domain/case/CaseResolver";
import { ambiguityChips, ambiguityMessage, buildCaseHint, caseChipLabel, closedReferenceChips, isPureSwitchCommand } from "../../src/services/LineCaseContextService";
import { shouldDeferToPendingIntake } from "../../src/domain/case/PendingIntake";

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

const resolver = new CaseResolver();
const openCases = [
  { id: 101, ticket_number: "TCK-2026-10101", subject: "ระบบชดใช้เงินยืม - ย้อนสถานะไม่ได้", summary: "ย้อนสถานะจากชำระแล้วเป็นค้างชำระไม่ได้", status: "IN_PROGRESS" },
  { id: 102, ticket_number: "TCK-2026-10102", subject: "ใบกำกับภาษี - ยอดไม่ตรง", summary: "ใบกำกับภาษีแสดงยอดเงินผิด", status: "TRIAGED" },
];
const closedCases = [
  { id: 201, ticket_number: "TCK-2026-20201", subject: "ล็อกอินไม่ได้", summary: "login failed", status: "CLOSED" },
];

check("L-01 exact reference → SWITCH hint carries the case; forceNew false", () => {
  const res = resolver.resolve({ conversationId: 1, activeTicketId: 101, messageText: "สลับไปที่ TCK-2026-10102", openCases, closedCases });
  assert.equal(res.type, "SWITCH_EXISTING_CASE");
  const hint = buildCaseHint(res, openCases.length);
  assert.equal(hint.intent, "SWITCH_EXISTING_CASE");
  assert.equal(hint.ticketId, 102);
  assert.equal(hint.ticketNumber, "TCK-2026-10102");
  assert.equal(hint.forceNew, false);
});

check("L-02 short continuation → CONTINUE hint on the active case", () => {
  const res = resolver.resolve({ conversationId: 1, activeTicketId: 101, messageText: "ยังไม่ได้ครับ", openCases, closedCases });
  assert.equal(res.type, "CONTINUE_ACTIVE_CASE");
  const hint = buildCaseHint(res, openCases.length);
  assert.equal(hint.ticketId, 101);
  assert.equal(hint.ticketNumber, "TCK-2026-10101");
});

check("L-03 NEW_CASE → forceNew only when an open case exists to fold into", () => {
  const res = resolver.resolve({ conversationId: 1, activeTicketId: null, messageText: "เปิดเคสใหม่ครับ ระบบจ่ายเงินผ่านบัตรเครดิตพัง", openCases, closedCases });
  assert.equal(res.type, "NEW_CASE");
  assert.equal(buildCaseHint(res, openCases.length).forceNew, true);
  assert.equal(buildCaseHint(res, 0).forceNew, false);
  assert.equal(buildCaseHint(res, openCases.length).ticketId, null);
});

check("L-04 closed-case reference → no routing ticket in the hint (never attach to a closed case)", () => {
  const res = resolver.resolve({ conversationId: 1, activeTicketId: 101, messageText: "เรื่อง TCK-2026-20201 ที่ปิดไปแล้ว ตอนนี้เจออีก", openCases, closedCases });
  assert.equal(res.type, "CLOSED_CASE_REFERENCE");
  assert.equal(res.referencedTicketId, 201);
  const hint = buildCaseHint(res, openCases.length);
  assert.equal(hint.ticketId, null);
  assert.equal(hint.ticketNumber, null);
});

check("L-05 ambiguity chips: system-name label per candidate (≤ 20 chars) plus 'แจ้งเรื่องใหม่'", () => {
  const chips = ambiguityChips(openCases);
  assert.equal(chips.length, 3);
  assert.equal(chips[0].label, "ระบบชดใช้เงินยืม");
  assert.equal(chips[0].text, "สลับไปที่ TCK-2026-10101");
  assert.equal(chips[1].label, "ใบกำกับภาษี");
  assert.ok(chips.every((c) => c.label.length <= 20));
  assert.equal(chips[2].text, "เปิดเคสใหม่");
});

check("L-05b duplicate system names are told apart by the number's tail; no subject falls back to the number", () => {
  const twins = [
    { id: 1, ticket_number: "TCK-2026-86186", subject: "ระบบเว็บไซต์ - เข้าใช้งานไม่ได้", status: "TRIAGED" },
    { id: 2, ticket_number: "TCK-2026-45367", subject: "ระบบเว็บไซต์ - 429 Too Many Requests", status: "OPEN" },
    { id: 3, ticket_number: "TCK-2026-00003", subject: null, status: "OPEN" },
  ];
  const chips = ambiguityChips(twins);
  assert.equal(chips[0].label, "ระบบเว็บไซต์ 86186");
  assert.equal(chips[1].label, "ระบบเว็บไซต์ 45367");
  assert.equal(chips[2].label, "TCK-2026-00003");
  assert.ok(chips.every((c) => c.label.length <= 20));
  assert.equal(caseChipLabel({ id: 4, ticket_number: "TCK-2026-00004", subject: "ระบบปฏิบัติงานนอกเวลาราชการยาวมาก - ยอดผิด" }).length, 20);
});

check("L-05c ambiguity body lists every case with number and subject", () => {
  const body = ambiguityMessage(openCases);
  assert.ok(body.includes("• TCK-2026-10101 ระบบชดใช้เงินยืม - ย้อนสถานะไม่ได้"));
  assert.ok(body.includes("• TCK-2026-10102 ใบกำกับภาษี - ยอดไม่ตรง"));
  assert.ok(body.startsWith("ตอนนี้มี 2 เคส"));
});

check("L-05d live 2026-09-18: 'แล้วเรื่องระบบล่ะคะ' with an active case is asked, not answered from the active case", () => {
  const live = [
    { id: 731, ticket_number: "TCK-2026-86186", subject: "ระบบเว็บไซต์ - เข้าใช้งานไม่ได้ และเป็นเคสด่วนมาก", summary: "ลูกค้าแจ้งว่าไม่สามารถเข้าใช้งานระบบเว็บไซต์ได้และระบุเป็นเคสด่วนมาก", status: "TRIAGED" },
    { id: 732, ticket_number: "TCK-2026-73046", subject: "ระบบชดใช้เงินยืม - ขอย้อนสถานะใบเสร็จเล่มที่ 05 เป็นค้างชำระ", summary: "ลูกค้าต้องการเปลี่ยนสถานะใบเสร็จเล่มที่ 05 จากชำระแล้วเป็นค้างชำระ", status: "TRIAGED" },
  ];
  const res = resolver.resolve({ conversationId: 99961, activeTicketId: 731, messageText: "แล้วเรื่องระบบล่ะคะ มีใครดูให้หรือยัง", openCases: live, closedCases: [] });
  assert.equal(res.type, "AMBIGUOUS_CASE");
  const chips = ambiguityChips(res.candidatesDetails || live);
  assert.deepEqual(chips.map((c) => c.label), ["ระบบเว็บไซต์", "ระบบชดใช้เงินยืม", "แจ้งเรื่องใหม่"]);
  assert.equal(buildCaseHint(res, live.length).ticketId, null);
});

check("L-06 closed-reference chips: reopen chip only inside the re-open window", () => {
  const recent = closedReferenceChips("TCK-2026-20201", new Date(Date.now() - 2 * 86_400_000), 7);
  assert.equal(recent.length, 2);
  assert.equal(recent[1].text, "ยังมีปัญหาอยู่ TCK-2026-20201");
  const old = closedReferenceChips("TCK-2026-20201", new Date(Date.now() - 30 * 86_400_000), 7);
  assert.equal(old.length, 1);
  // 2026-09-18: the tap names the closed case so the follow-up can be linked.
  assert.equal(old[0].text, "เปิดเคสใหม่: ติดตามต่อจาก TCK-2026-20201");
  assert.equal(closedReferenceChips(null, null, 7).length, 1);
  assert.equal(closedReferenceChips(null, null, 7)[0].text, "เปิดเคสใหม่");
});

check("L-07 pure switch commands are answered at the edge; content is forwarded", () => {
  assert.equal(isPureSwitchCommand("สลับไปที่ TCK-2026-10102"), true);
  assert.equal(isPureSwitchCommand("ตามเรื่อง TCK-2026-10102 ครับ"), true);
  assert.equal(isPureSwitchCommand("TCK-2026-10102"), true);
  assert.equal(isPureSwitchCommand("TCK-2026-10102 ส่งรูปเพิ่มครับ หน้าจอขึ้น 500"), false);
  assert.equal(isPureSwitchCommand("เคส TCK-2026-10102 ถึงไหนแล้วคะ"), false);
});

check("L-08 the switch chip text resolves as an exact reference on the next turn", () => {
  const res = resolver.resolve({ conversationId: 1, activeTicketId: null, messageText: "สลับไปที่ TCK-2026-10101", openCases, closedCases });
  assert.equal(res.type, "SWITCH_EXISTING_CASE");
  assert.equal(res.ticketId, 101);
});

check("L-09 a correction mid-intake never references a closed case by an urgency word (live 2026-09-17, TCK-2026-83960)", () => {
  // Real rows from conversation 99961: every case closed, the customer is answering
  // the "which part to change?" question. Before the fix the resolver produced
  // EXPLICIT_TOPIC_MATCH: "ด่วนมาก" (+0.65) and the closed-case protection was sent.
  const closed = [
    {
      id: 439,
      ticket_number: "TCK-2026-83960",
      subject: "ระบบเว็บไซต์ - ข้อความแสดงข้อผิดพลาด 401 Unauthorized เข้าใช้งานไม่ได้",
      summary: "ลูกค้าแจ้งไม่สามารถเข้าใช้งานเว็บไซต์ได้เนื่องจากระบบแสดงข้อความ 401 Unauthorized ทุกเมนูและทุกแพลตฟอร์ม เป็นเรื่องด่วนมาก",
      status: "CLOSED",
    },
  ];
  const res = resolver.resolve({
    conversationId: 99961,
    activeTicketId: null,
    messageText: "ขอแก้อาการเป็น เข้าใช้งานไม่ได้เลย และเป็นเคสด่วนมากครับ",
    openCases: [],
    closedCases: closed,
    recentMessages: [],
  });
  assert.notEqual(res.type, "CLOSED_CASE_REFERENCE");
  assert.equal(res.type, "NEW_CASE");
  assert.ok(!res.evidence.some((e) => e.includes('EXPLICIT_TOPIC_MATCH: "ด่วนมาก"')), res.evidence.join(", "));
  // The guard in front of the resolver stands down for the same turn regardless of scoring.
  assert.equal(shouldDeferToPendingIntake("ขอแก้อาการเป็น เข้าใช้งานไม่ได้เลย และเป็นเคสด่วนมากครับ", "ได้เลยค่ะ ต้องการแก้ไขส่วนไหนคะ ชื่อระบบ อาการ หรือรายละเอียด พิมพ์บอกแอดมินได้เลยนะคะ\nแก้ไขแล้วแอดมินจะสรุปให้ยืนยันอีกครั้งนะคะ"), "edit");
});

check("L-10 a real topic after 'เรื่อง' still matches (stoplist only drops generic words)", () => {
  const res = resolver.resolve({ conversationId: 1, activeTicketId: null, messageText: "ขอกลับมาดูเรื่องล็อกอินไม่ได้ครับ", openCases, closedCases });
  assert.equal(res.type, "CLOSED_CASE_REFERENCE");
  assert.equal(res.referencedTicketId, 201);
});

console.log(`\n${passed} checks passed${process.exitCode ? ", with failures" : ""}`);
