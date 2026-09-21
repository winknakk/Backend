/**
 * W1 / W2 / W3 focused regression — ISSUE-080/081 final reconciliation.
 *
 * W3 is the high-priority one: a single OPEN ticket must not become the routing
 * target for an unrelated message merely because it is the only one open.
 *
 * Pure: no DB, no network, no PromptX, no backend. `CaseResolver.resolve` and
 * the intent detectors take all their input as arguments.
 *
 * Required rule (operator, ISSUE-080/081 reconciliation brief §4):
 *   CONTINUE_ACTIVE_CASE requires evidence — active case context, follow-up or
 *   continuation language, compatible topic, recent context, no topic shift,
 *   no strong signal of a new unrelated issue. "One open case => route
 *   everything to it" is explicitly NOT acceptable.
 */
import { caseResolver, type CaseCandidate } from "./domain/case/CaseResolver";
import { detectCloseIntent } from "./domain/ticket/CustomerConfirmation";

const LOAN: CaseCandidate = {
  id: 7301,
  ticket_number: "TCK-2026-73046",
  subject: "ระบบชดใช้เงินยืม - ขอย้อนสถานะใบเสร็จเล่มที่ 05 เป็นค้างชำระ",
  summary: "ต้องการย้อนสถานะใบเสร็จเล่มที่ 05 จากชำระแล้วเป็นค้างชำระ",
  status: "IN_PROGRESS",
  created_at: "2026-09-17T09:37:31.000Z",
};
const WEB: CaseCandidate = {
  id: 8618,
  ticket_number: "TCK-2026-86186",
  subject: "ระบบเว็บไซต์ - เข้าใช้งานไม่ได้ และเป็นเคสด่วนมาก",
  summary: "เข้าเว็บไซต์ไม่ได้ ขึ้นหน้า error",
  status: "IN_PROGRESS",
  created_at: "2026-09-17T08:17:34.000Z",
};

function resolve(text: string, open: CaseCandidate[], active: CaseCandidate | null = null) {
  return caseResolver.resolve({
    conversationId: 99999,
    activeTicketId: active?.id ?? null,
    messageText: text,
    openCases: open,
    closedCases: [],
    recentMessages: [],
  });
}

interface Case {
  id: string;
  what: string;
  run: () => { ok: boolean; got: string; want: string };
}

const CASES: Case[] = [
  // ------------------------------------------------------------------ W3 A
  {
    id: "W3-A",
    what: "one open LOAN case, message about the WEBSITE -> must NOT route to the loan case",
    run: () => {
      const r = resolve("เว็บไซต์เข้าใช้งานไม่ได้เลยค่ะ", [LOAN]);
      const routed = (r as any).routingTicketId ?? r.ticketId ?? null;
      return {
        ok: routed !== LOAN.id,
        got: `${r.decision} route=${routed} conf=${r.confidence} evidence=${(r.evidence || []).join(",")}`,
        want: `anything but a route to ${LOAN.ticket_number}`,
      };
    },
  },
  // ------------------------------------------------------------------ W3 B
  {
    id: "W3-B",
    what: "one open WEBSITE case, message about the WEBSITE -> may continue it",
    run: () => {
      const r = resolve("เว็บไซต์เข้าใช้งานไม่ได้เลยค่ะ", [WEB]);
      const routed = (r as any).routingTicketId ?? r.ticketId ?? null;
      return {
        ok: routed === WEB.id || r.decision === "CONTINUE_ACTIVE_CASE",
        got: `${r.decision} route=${routed} conf=${r.confidence}`,
        want: `continue / route to ${WEB.ticket_number} (topic is compatible)`,
      };
    },
  },
  // ------------------------------------------------------------------ W3 C
  {
    id: "W3-C",
    what: "one open case, message with an explicit topic shift -> must NOT silently continue",
    run: () => {
      const r = resolve("แล้วเรื่องระบบลางานล่ะคะ กดส่งใบลาไม่ได้เลย", [LOAN]);
      const routed = (r as any).routingTicketId ?? r.ticketId ?? null;
      return {
        ok: !(r.decision === "CONTINUE_ACTIVE_CASE" && routed === LOAN.id),
        got: `${r.decision} route=${routed} conf=${r.confidence} evidence=${(r.evidence || []).join(",")}`,
        want: "NEW_CASE or AMBIGUOUS_CASE — never a silent continue of the loan case",
      };
    },
  },
  // ------------------------------------------------------------------- W1
  {
    id: "W1-a",
    what: "detectCloseIntent('ขอปิดเคสนี้ค่ะ') -> CLOSE_REQUEST with isThisCaseRef = true",
    run: () => {
      const r = detectCloseIntent("ขอปิดเคสนี้ค่ะ");
      return {
        ok: r.kind === "CLOSE_REQUEST" && r.isThisCaseRef === true,
        got: `kind=${r.kind} isThisCaseRef=${r.isThisCaseRef} ticketNumber=${r.ticketNumber}`,
        want: "kind=CLOSE_REQUEST isThisCaseRef=true",
      };
    },
  },
  {
    id: "W1-b",
    what: "negative-intent safety preserved after the W1 change",
    run: () => {
      const r = detectCloseIntent("ปิดเคสไม่ได้ครับ ระบบขึ้น error");
      return { ok: r.kind === "NONE", got: `kind=${r.kind}`, want: "kind=NONE" };
    },
  },
  {
    id: "W1-c",
    what: "'ขอปิดเคส TCK-… ค่ะ' still carries the number and is not a this-case ref",
    run: () => {
      const r = detectCloseIntent("ขอปิดเคส TCK-2026-86186 ค่ะ");
      return {
        ok: r.kind === "CLOSE_REQUEST" && r.ticketNumber === "TCK-2026-86186" && r.isThisCaseRef !== true,
        got: `kind=${r.kind} num=${r.ticketNumber} isThisCaseRef=${r.isThisCaseRef}`,
        want: "CLOSE_REQUEST, number kept, isThisCaseRef falsy",
      };
    },
  },
  // ------------------------------------------------------------------- W2
  {
    id: "W2",
    what: "unrelated new issue while LOAN is active -> must not fold into LOAN",
    run: () => {
      const r = resolve("ขอแจ้งปัญหาใหม่ค่ะ ระบบลางานกดปุ่มส่งไม่ได้เลยค่ะ", [LOAN], LOAN);
      const routed = (r as any).routingTicketId ?? r.ticketId ?? null;
      return {
        ok: !(r.decision === "CONTINUE_ACTIVE_CASE" && routed === LOAN.id),
        got: `${r.decision} route=${routed}`,
        want: "NEW_CASE (or ask) — never a silent continue",
      };
    },
  },
  // --------------------------------------------- contract shape (Agent 1)
  {
    id: "SHAPE",
    what: "result exposes the ISSUE-080 contract fields (routingTicketId, referencedTicketId)",
    run: () => {
      const r: any = resolve("เว็บไซต์เข้าใช้งานไม่ได้เลยค่ะ", [LOAN]);
      const has = "routingTicketId" in r && "referencedTicketId" in r;
      return {
        ok: has,
        got: `routingTicketId=${"routingTicketId" in r} referencedTicketId=${"referencedTicketId" in r} outcome=${"outcome" in r}`,
        want: "both present",
      };
    },
  },
];

let pass = 0;
const fails: string[] = [];

console.log("W1 / W2 / W3 focused regression (pure: no DB, no network, no PromptX)\n");
for (const c of CASES) {
  const { ok, got, want } = c.run();
  if (ok) pass += 1;
  else fails.push(`${c.id}: ${c.what}\n        want: ${want}\n        got : ${got}`);
  console.log(`  ${ok ? "ผ่าน" : "พลาด"}  ${c.id.padEnd(7)} ${c.what}`);
  console.log(`          ${got}`);
}

console.log("\n" + "=".repeat(100));
console.log(`ผ่าน ${pass}/${CASES.length}`);
if (fails.length) {
  console.log(`\nพลาด ${fails.length}:`);
  fails.forEach((f) => console.log("  " + f));
  process.exit(1);
}
