/**
 * ISSUE-080 / ISSUE-081 — decision-layer contract for close requests.
 *
 * ISSUE-080: an OPEN case must win over a CLOSED case that shares its wording,
 *            and a CLOSED case must never become a routing target.
 * ISSUE-081: a close request with no resolvable target must ASK, never guess.
 *
 * Scope (Agent 2): verifies the DECISION contract. It does not re-implement or
 * redesign the resolver — it calls the real `caseResolver` and the real intent
 * detectors and asserts what they return. Resolver/authorization changes are
 * Agent 1's; defects found here are reported, not patched.
 *
 * Side-effect free ON PURPOSE: `CaseResolver.resolve` and the detectors are
 * pure, so this runs with **no database, no network, and no PromptX call**.
 * `CustomerConfirmationHandler.handle()` is deliberately NOT called — it reads
 * the live DB and its `notify()` pushes a real LINE message to a real customer.
 *
 * Fixtures are synthetic but shaped like the real demo conversation:
 *   A  OPEN    ระบบชดใช้เงินยืม …
 *   B  OPEN    ระบบเว็บไซต์ - เข้าใช้งานไม่ได้ และเป็นเคสด่วนมาก
 *   C  CLOSED  ระบบเว็บไซต์ - เข้าใช้งานไม่ได้      <- deliberately near-identical to B
 *
 * Two sections:
 *   CONTRACT    — must hold. A failure exits non-zero.
 *   DEFECT WATCH— current behaviour of known-open defects (owner: Agent 1).
 *                 Reported, and flagged loudly if the behaviour changes, but
 *                 does not fail the gate. Promote a row to CONTRACT once fixed.
 */
import { caseResolver, type CaseCandidate } from "./domain/case/CaseResolver";
import { detectCloseIntent, detectCancelIntent } from "./domain/ticket/CustomerConfirmation";

const A: CaseCandidate = {
  id: 7301,
  ticket_number: "TCK-2026-73046",
  subject: "ระบบชดใช้เงินยืม - ขอย้อนสถานะใบเสร็จเล่มที่ 05 เป็นค้างชำระ",
  summary: "ต้องการย้อนสถานะใบเสร็จเล่มที่ 05 จากชำระแล้วเป็นค้างชำระ",
  status: "IN_PROGRESS",
  created_at: "2026-09-17T09:37:31.000Z",
};
const B: CaseCandidate = {
  id: 8618,
  ticket_number: "TCK-2026-86186",
  subject: "ระบบเว็บไซต์ - เข้าใช้งานไม่ได้ และเป็นเคสด่วนมาก",
  summary: "เข้าเว็บไซต์ไม่ได้ ขึ้นหน้า error",
  status: "IN_PROGRESS",
  created_at: "2026-09-17T08:17:34.000Z",
};
const C: CaseCandidate = {
  id: 8396,
  ticket_number: "TCK-2026-83960",
  subject: "ระบบเว็บไซต์ - เข้าใช้งานไม่ได้",
  summary: "เข้าเว็บไซต์ไม่ได้ เป็นเรื่องด่วนมาก",
  status: "CLOSED",
  created_at: "2026-09-15T04:00:00.000Z",
};

const OPEN = [A, B];
const CLOSED = [C];

interface Row {
  id: string;
  what: string;
  text: string;
  active?: CaseCandidate | null;
  open?: CaseCandidate[];
  closed?: CaseCandidate[];
  decision: string;
  routeTo?: number | null;
  refTo?: number | null;
  closeKind?: string;
  /** why this is not yet CONTRACT, and who owns it */
  defect?: string;
}

function run(r: Row) {
  const res = caseResolver.resolve({
    conversationId: 99999,
    activeTicketId: r.active?.id ?? null,
    messageText: r.text,
    openCases: r.open ?? OPEN,
    closedCases: r.closed ?? CLOSED,
    recentMessages: [],
  });
  const closeGot = r.closeKind ? detectCloseIntent(r.text).kind : "-";
  const why: string[] = [];
  if (res.decision !== r.decision) why.push(`decision ${r.decision} != ${res.decision}`);
  if (r.routeTo !== undefined && (res.ticketId ?? null) !== r.routeTo)
    why.push(`route ${r.routeTo} != ${res.ticketId ?? null}`);
  if (r.refTo !== undefined && (res.referencedTicketId ?? null) !== r.refTo)
    why.push(`ref ${r.refTo} != ${res.referencedTicketId ?? null}`);
  if (r.closeKind && closeGot !== r.closeKind) why.push(`close ${r.closeKind} != ${closeGot}`);
  return { res, closeGot, why };
}

// ===========================================================================
// CONTRACT — must hold
// ===========================================================================
const CONTRACT: Row[] = [
  // --- ISSUE-081: close with nothing resolvable -> ask, never pick ---------
  { id: "M1", what: "close, no active, two open -> ask, must not pick one", text: "ขอปิดเคสค่ะ", active: null, decision: "AMBIGUOUS_CASE", routeTo: null, closeKind: "CLOSE_REQUEST" },
  { id: "M2", what: "close, no active, no cases at all -> must not invent a target", text: "ขอปิดเคสค่ะ", active: null, open: [], decision: "NEW_CASE", routeTo: null, closeKind: "CLOSE_REQUEST" },
  { id: "M1b", what: "cancel, no active, two open -> ask (same rule as close)", text: "ขอยกเลิกเคสค่ะ", active: null, decision: "AMBIGUOUS_CASE", routeTo: null },

  // --- active case --------------------------------------------------------
  { id: "M3", what: "'ปิดเคสนี้' with active A -> routes to A and produces CLOSE_REQUEST", text: "ขอปิดเคสนี้ค่ะ", active: A, decision: "CONTINUE_ACTIVE_CASE", routeTo: A.id, closeKind: "CLOSE_REQUEST" },

  // --- explicit reference beats active ------------------------------------
  { id: "M4", what: "explicit B while active is A -> B wins", text: "ขอปิดเคส TCK-2026-86186 ค่ะ", active: A, decision: "SWITCH_EXISTING_CASE", routeTo: B.id, closeKind: "CLOSE_REQUEST" },

  // --- ISSUE-080: a CLOSED case is referenced, never routed to ------------
  { id: "M5", what: "explicit CLOSED C -> referenced, not routed", text: "ขอปิดเคส TCK-2026-83960 ค่ะ", active: A, decision: "CLOSED_CASE_REFERENCE", routeTo: null, refTo: C.id },
  { id: "M6", what: "ISSUE-080: wording shared with closed C never selects C", text: "เรื่องเว็บเข้าไม่ได้ถึงไหนแล้วคะ", active: null, decision: "SWITCH_EXISTING_CASE", routeTo: B.id, refTo: null },
  // --- W2 / W3: promoted from defect watch (ISSUE-080/081 fixed) ----------
  { id: "W2", what: "unrelated new issue while A is active -> NEW_CASE, never folded into A", text: "ขอแจ้งปัญหาใหม่ค่ะ ระบบลางานกดปุ่มส่งไม่ได้เลยค่ะ", active: A, decision: "NEW_CASE", routeTo: null },
  { id: "W3", what: "unrelated message with only open case A -> references closed C, never routes to A", text: "เรื่องเว็บเข้าไม่ได้ถึงไหนแล้วคะ", active: null, open: [A], decision: "CLOSED_CASE_REFERENCE", routeTo: null, refTo: C.id },
];

// ===========================================================================
// DEFECT WATCH — current behaviour of known-open defects. Owner: Agent 1.
// All previously tracked defects (W1, W2, W3) are now resolved and promoted to CONTRACT.
// ===========================================================================
const WATCH: Row[] = [];

// Negative-intent regression (section 7). These must NEVER close or cancel.
const NEGATIVES: [string, string][] = [
  ["ปิดเคสไม่ได้ครับ ระบบขึ้น error", "the canonical negative — must never weaken"],
  ["ปิดเคสไม่ได้ค่ะ", "same, female particle"],
  ["ระบบขึ้น error ตอนปิดเคส", "command word mid-sentence in a report"],
  ["ลองปิดเคสแล้วไม่ได้", "attempted-and-failed report"],
  ["ยกเลิกไม่ได้ ระบบ error", "cancel variant of the same shape"],
  ["กดปิดเคสแล้วเด้งออกเลยค่ะ", "UI failure report"],
  ["ทำไมเคสยังไม่ปิดคะ", "a question, not a command"],
];

let pass = 0;
const fails: string[] = [];
const drifted: string[] = [];

console.log("ISSUE-080 / ISSUE-081 — decision matrix (pure: no DB, no network, no PromptX)\n");
console.log("CONTRACT");
console.log(`  ${"ID".padEnd(5)} ${"decision".padEnd(24)} ${"route".padEnd(7)} ${"ref".padEnd(6)} ${"close".padEnd(15)} ผล`);
console.log("  " + "-".repeat(96));
for (const r of CONTRACT) {
  const { res, closeGot, why } = run(r);
  if (why.length === 0) pass += 1;
  else fails.push(`${r.id} (${r.what}) — ${why.join("; ")}  | "${r.text}"`);
  console.log(
    `  ${r.id.padEnd(5)} ${String(res.decision).padEnd(24)} ${String(res.ticketId ?? "-").padEnd(7)} ` +
      `${String(res.referencedTicketId ?? "-").padEnd(6)} ${closeGot.padEnd(15)} ${why.length === 0 ? "ผ่าน" : "พลาด"}`
  );
}

// A CLOSED case must never be handed back as a routing target, in any row.
let closedLeak = 0;
for (const r of [...CONTRACT, ...WATCH]) {
  const { res } = run(r);
  if (res.ticketId === C.id) {
    closedLeak += 1;
    fails.push(`${r.id} routed to the CLOSED case ${C.ticket_number}`);
  }
}
pass += closedLeak === 0 ? 1 : 0;
console.log(`\nCLOSED-mutation guard: ${closedLeak === 0 ? "ผ่าน — ไม่มี row ไหน route ไปเคสที่ปิดแล้ว" : `พลาด — ${closedLeak} row`}`);

console.log("\nDEFECT WATCH (เจ้าของ: Agent 1 — ไม่ทำให้ suite แดง แต่เตือนถ้าพฤติกรรมเปลี่ยน)");
for (const r of WATCH) {
  const { res, closeGot, why } = run(r);
  if (why.length === 0) {
    console.log(`  ${r.id}  คงเดิม   decision=${res.decision} route=${res.ticketId ?? "-"} close=${closeGot}`);
  } else {
    drifted.push(`${r.id} (${r.what}) — behaviour changed: ${why.join("; ")}`);
    console.log(`  ${r.id}  ** เปลี่ยน ** ${why.join("; ")}`);
  }
  console.log(`        ${r.defect}`);
}

console.log("\nNegative intent (must never close or cancel)");
for (const [text, why] of NEGATIVES) {
  const c = detectCloseIntent(text).kind;
  const x = detectCancelIntent(text).kind;
  const ok = c === "NONE" && x === "NONE";
  if (ok) pass += 1;
  else fails.push(`NEG close=${c} cancel=${x} — "${text}"  [${why}]`);
  console.log(`  ${ok ? "ผ่าน" : "พลาด"}  close=${c.padEnd(14)} cancel=${x.padEnd(15)} "${text}"`);
}

console.log("\n" + "=".repeat(100));
console.log(`CONTRACT ผ่าน ${pass} เช็ค  |  DEFECT WATCH ${WATCH.length} รายการ`);
if (drifted.length) {
  console.log("\nพฤติกรรมของ defect ที่เฝ้าดูเปลี่ยนไป — ตรวจสอบและเลื่อนขึ้นเป็น CONTRACT ถ้าแก้แล้ว:");
  drifted.forEach((d) => console.log("  " + d));
}
if (fails.length) {
  console.log(`\nCONTRACT พลาด ${fails.length}:`);
  fails.forEach((f) => console.log("  " + f));
  process.exit(1);
}
console.log("CONTRACT ผ่านทั้งหมด");
