/** Why does the open-vs-closed row resolve the way it does? Pure, no DB. */
import { caseResolver, type CaseCandidate } from "./domain/case/CaseResolver";

const A: CaseCandidate = { id: 7301, ticket_number: "TCK-2026-73046", subject: "ระบบชดใช้เงินยืม - ขอย้อนสถานะใบเสร็จเล่มที่ 05 เป็นค้างชำระ", summary: "ต้องการย้อนสถานะใบเสร็จเล่มที่ 05", status: "IN_PROGRESS", created_at: "2026-09-17T09:37:31.000Z" };
const B: CaseCandidate = { id: 8618, ticket_number: "TCK-2026-86186", subject: "ระบบเว็บไซต์ - เข้าใช้งานไม่ได้ และเป็นเคสด่วนมาก", summary: "เข้าเว็บไซต์ไม่ได้ ขึ้นหน้า error", status: "IN_PROGRESS", created_at: "2026-09-17T08:17:34.000Z" };
const C: CaseCandidate = { id: 8396, ticket_number: "TCK-2026-83960", subject: "ระบบเว็บไซต์ - เข้าใช้งานไม่ได้", summary: "เข้าเว็บไซต์ไม่ได้ เป็นเรื่องด่วนมาก", status: "CLOSED", created_at: "2026-09-15T04:00:00.000Z" };

const CASES: { label: string; text: string; open: CaseCandidate[]; closed: CaseCandidate[] }[] = [
  { label: "open B + closed C (ISSUE-080 core)", text: "เรื่องเว็บเข้าไม่ได้ถึงไหนแล้วคะ", open: [A, B], closed: [C] },
  { label: "same wording, closed C REMOVED", text: "เรื่องเว็บเข้าไม่ได้ถึงไหนแล้วคะ", open: [A, B], closed: [] },
  { label: "same wording, open B REMOVED", text: "เรื่องเว็บเข้าไม่ได้ถึงไหนแล้วคะ", open: [A], closed: [C] },
  { label: "close 'นี้' with active A", text: "ขอปิดเคสนี้ค่ะ", open: [A, B], closed: [C] },
];

for (const c of CASES) {
  const r = caseResolver.resolve({
    conversationId: 99999,
    activeTicketId: c.label.includes("active A") ? A.id : null,
    messageText: c.text,
    openCases: c.open,
    closedCases: c.closed,
    recentMessages: [],
  });
  console.log(`\n--- ${c.label} ---`);
  console.log(`  text      : "${c.text}"`);
  console.log(`  decision  : ${r.decision}`);
  console.log(`  ticketId  : ${r.ticketId}   referenced: ${r.referencedTicketId ?? "-"}   confidence: ${r.confidence}`);
  console.log(`  candidates: ${JSON.stringify(r.candidates)}`);
  console.log(`  evidence  :`);
  (r.evidence || []).forEach((e) => console.log(`      - ${e}`));
}
