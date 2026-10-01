/**
 * PM1 UAT behavioural contract — what TicketX already guarantees, and which
 * gaps the PM1 support chat exposed.
 *
 * Source of the behaviours: docs/PM1_UAT_Support_Chat_แยกตามเคส.md (39 real
 * PM1-Support UAT cases, 6 ส.ค.–26 ก.ย. 2569). PM1 is a DIFFERENT product; the
 * cases are evidence of how support conversations go, not TicketX policy.
 * Nothing here copies chat text: every fixture is synthetic, with no names,
 * usernames, URLs, tokens or identifiers.
 *
 * Side-effect free ON PURPOSE: no database, no network, no PromptX call. It
 * calls the real pure detectors / lifecycle guard and reads tracked assets
 * (the canonical flow JSON, the Ticket Operations Hub JSON, env.ts, migrations)
 * as text. Secrets found in assets are COUNTED, never printed.
 *
 * Two sections (same convention as test-close-resolution-matrix.ts):
 *   CONTRACT   — existing behaviour the PM1 cases rely on. A failure exits 1.
 *   KNOWN GAP  — confirmed gaps (P0/P1/P2). Reported, non-fatal; flagged loudly
 *                if the detected state changes, so a fix gets promoted to
 *                CONTRACT instead of going unnoticed.
 * Owner decisions that block a contract are listed as NEEDS_VERIFICATION and
 * point at .ai/PM1_VERIFICATION_QUESTIONS.md; they are not asserted.
 *
 * NOTE ON DEPLOYMENT: prompt checks read the tracked canonical asset. Passing
 * here does NOT prove the deployed PromptX flow matches it.
 */
import fs from "fs";
import path from "path";
import {
  detectCloseIntent,
  detectReopenScope,
  detectConfirmationIntent,
} from "./domain/ticket/CustomerConfirmation";
import { canTransition } from "./domain/ticket/TicketLifecycle";

const ROOT = path.resolve(__dirname, "../../..");
const FLOW_DIR = path.join(ROOT, "แล้วกู๊ดจะกลับมาใน AVENGERS DOOMSDAY/All Workflows (ใช้งานในปัจจุบัน)");
const MAIN_FLOW = path.join(FLOW_DIR, "Main AI Core Flow.json");
const HUB_FLOW = path.join(FLOW_DIR, "Sub Flow - Ticket Operations Hub.json");
const BACKEND = path.resolve(__dirname, "..");

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));

function stepSettings(root: unknown): Record<string, any> {
  const out: Record<string, any> = {};
  (function walk(n: any) {
    if (n && typeof n === "object") {
      if (!Array.isArray(n) && typeof n.name === "string" && n.type) out[n.name] = n.settings ?? {};
      for (const v of Object.values(n)) walk(v);
    }
  })(root);
  return out;
}

const mainRaw = fs.readFileSync(MAIN_FLOW, "utf8");
const main = stepSettings(readJson(MAIN_FLOW));
const hub = stepSettings(readJson(HUB_FLOW));

/** Same extraction as test-prompt-safety-contract.ts: run the pure CODE step. */
function customerSystemPrompt(): string {
  const code = String(main.step_system_prompt?.sourceCode?.code ?? "");
  const sync = code.replace(/exports\.code\s*=\s*async\s*\(/, "exports.code = (");
  if (!code || sync === code || /\bawait\b/.test(sync)) {
    console.log("ERR: step_system_prompt is no longer a plain `exports.code = async () => ({ systemPrompt })`");
    process.exit(1);
  }
  const mod: { exports: any } = { exports: {} };
  new Function("exports", "module", sync)(mod.exports, mod);
  return String(mod.exports.code()?.systemPrompt ?? "");
}
const customerPrompt = customerSystemPrompt();
const gatePrompt = String(main.step_gate_agent?.input?.message ?? "");
if (!customerPrompt || !gatePrompt) {
  console.log("ERR: could not extract prompts from the flow asset");
  process.exit(1);
}

const hubSql = (name: string) => JSON.stringify(hub[name] ?? {});
const serverSrc = fs.readFileSync(path.join(BACKEND, "src/api/server.ts"), "utf8");
const envSrc = fs.readFileSync(path.join(BACKEND, "src/config/env.ts"), "utf8");
const lineWebhookSrc = fs.readFileSync(path.join(BACKEND, "src/api/routes/lineWebhook.ts"), "utf8");
const migrationsDir = path.join(BACKEND, "database/migrations");
const migrationsSql = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => fs.readFileSync(path.join(migrationsDir, f), "utf8"))
  .join("\n");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// ===========================================================================
// CONTRACT — must hold
// ===========================================================================
interface Check {
  id: string;
  pm1: string; // PM1 source case(s) motivating the check
  what: string;
  ok: boolean;
  detail?: string;
}
const contract: Check[] = [];
const must = (id: string, pm1: string, what: string, ok: boolean, detail?: string) =>
  contract.push({ id, pm1, what, ok, detail });

// T1 status inquiry — answer from the real ticket, never invent a status/ETA.
must("T1a", "1,14,22,23", "gate routes progress questions to a real lookup (GET_STATUS / FIND)",
  /- GET_STATUS: asks about progress AND gives a ticket number/.test(gatePrompt) &&
    /- FIND: asks about their open or current case without a ticket number/.test(gatePrompt));
must("T1b", "1,23", "customer prompt forbids stating a status/date that is not in context, and estimating it",
  /Never state a ticket number, status, priority, date, or time that does not appear verbatim/.test(customerPrompt) &&
    /never estimate it/.test(customerPrompt));

// T2 repeated issue — "same as before" is recognised as the SAME problem.
for (const [text, want] of [
  ["ยังเหมือนเดิมเลยค่ะ", "SAME"],
  ["อาการเดิมยังไม่หายครับ", "SAME"],
  ["เป็นปัญหาใหม่ค่ะ คนละเรื่องกับอันเดิม", "NEW"],
] as const) {
  const got = detectReopenScope(text);
  must("T2", "3,7,16,20,26", `reopen scope "${text}" -> ${want}`, got === want, `got ${got}`);
}

// T3 reopen — the model never reopens by itself; the button decides.
must("T3a", "16,17,20", "gate: REOPEN never reopens the case by itself (button confirm)",
  /REOPEN never reopens the case by itself/.test(gatePrompt));
must("T3b", "16,17,20", "lifecycle: a customer may reopen a RESOLVED case",
  canTransition("RESOLVED", "REOPENED", "customer").allowed, JSON.stringify(canTransition("RESOLVED", "REOPENED", "customer")));

// T4 customer confirmation — a fix notice is not a resolution; only the customer confirms.
must("T4a", "3,6,15,16,17,20,33,34", "lifecycle: Plane cannot move RESOLVED -> CUSTOMER_CONFIRMED",
  !canTransition("RESOLVED", "CUSTOMER_CONFIRMED", "plane").allowed);
must("T4b", "15,18", "lifecycle: the customer can move RESOLVED -> CUSTOMER_CONFIRMED",
  canTransition("RESOLVED", "CUSTOMER_CONFIRMED", "customer").allowed);
must("T4c", "3,15", "gate: CLOSE never closes the case by itself",
  /CLOSE never closes the case by itself/.test(gatePrompt));
for (const text of ["ขอบคุณค่ะ", "ขอบคุณมากเลยค่ะ", "รับทราบครับ", "ยืนยัน"]) {
  const k = detectCloseIntent(text).kind;
  must("T4d", "3,15,30", `"${text}" with no close question pending is not a close`, k === "NONE", `got ${k}`);
}

// T5 multi-issue message: see KNOWN GAP G-P1-1 (single ticket per gate turn).

// T6 partial verification — "some items pass, one fails" is never read as a confirmed fix.
for (const text of [
  "ข้อ 2 ถึง 6 ใช้งานได้แล้วค่ะ แต่ข้อ 1 ยังไม่ได้",
  "ส่วนรายงานใช้ได้แล้ว แต่ตัวเลขใน dashboard ยังไม่ตรงค่ะ",
]) {
  const scope = detectReopenScope(text);
  const close = detectCloseIntent(text).kind;
  must("T6", "30,33,34", `partial pass is AMBIGUOUS and not CONFIRM_CLOSE: "${text}"`,
    scope === "AMBIGUOUS" && close !== "CONFIRM_CLOSE", `scope=${scope} close=${close}`);
}

// T8 missing required information — ask, and never loop the same question.
must("T8", "3,9,15,21,22,31,32,33,36", "gate: NEED_INFO exists and is never used twice in a row",
  /- NEED_INFO: reports a problem with nothing concrete/.test(gatePrompt) &&
    /NEED_INFO[^\n]*Never twice in a row/.test(gatePrompt));

// T10 account information — no AI-callable tool can look up another person's account.
const registerBlock = (serverSrc.match(/export function registerLocalTools\(\): void \{([\s\S]*?)\n\}/) ?? [])[1] ?? "";
must("T10", "37", "registerLocalTools registers no user/account/customer lookup tool",
  registerBlock.length > 0 && !/new \w*(User|Account|Customer|Profile|Identity)\w*Tool\b/.test(registerBlock),
  registerBlock ? undefined : "registerLocalTools block not found");

// T11 escalation — an explicit request for a human is routed to a human.
must("T11", "20,22,39", "gate: ESCALATE on a request for a human/operator, mapped to HUMAN_REQUEST",
  /- ESCALATE: asks for a human, a manager, or an operator/.test(gatePrompt) &&
    /HUMAN_REQUEST \/ "human" \/ true: ticket_action ESCALATE/.test(gatePrompt));

// T12 customer silence — never resolves an unfixed case. The only silence rule in
// TicketX is the operator-approved auto-close of a DELIVERED (RESOLVED) case,
// off unless SLA_CADENCE_ENABLED=true (.ai/STATUS.md 2026-09-29).
must("T12a", "13,25,28,31,32,39", "SLA_CADENCE_ENABLED (auto-close after silence) defaults to false",
  /SLA_CADENCE_ENABLED:\s*z\.enum\(\["true", "false"\]\)\.default\("false"\)/.test(envSrc));
for (const from of ["NEW", "OPEN", "IN_PROGRESS", "WAITING_CUSTOMER"] as const) {
  const c = canTransition(from, "CLOSED", "system");
  must("T12b", "13,28,31", `lifecycle: the system cannot close an unresolved ${from} case`, !c.allowed, JSON.stringify(c));
}

// Internal information — customer prompt bans internal vocabulary.
must("T13", "10,22,33", "customer prompt: NO INTERNAL VOCABULARY rule present",
  /NO INTERNAL VOCABULARY\. Never echo any of:/.test(customerPrompt));

// Sanity: the detector the confirmations rely on still treats thanks as neutral.
must("T4e", "3,18", 'detectConfirmationIntent("ขอบคุณค่ะ") is not REJECTED',
  detectConfirmationIntent("ขอบคุณค่ะ") !== "REJECTED", detectConfirmationIntent("ขอบคุณค่ะ"));

// ===========================================================================
// KNOWN GAP — confirmed, reported, non-fatal
// ===========================================================================
interface Gap {
  id: string;
  priority: "P0" | "P1" | "P2";
  pm1: string;
  what: string;
  /** true = the gap is still present (expected today) */
  present: boolean;
  evidence: string;
}
const gaps: Gap[] = [];
const gap = (g: Gap) => gaps.push(g);

const bearerCount = (mainRaw.match(/Bearer [A-Za-z0-9+/=]{150,}/g) ?? []).length;
gap({
  id: "G-P0-1", priority: "P0", pm1: "(repo audit)",
  what: "canonical Main AI Core Flow hard-codes a long-lived LINE Bearer token (count only, never printed)",
  present: bearerCount > 0,
  evidence: `${bearerCount} literal(s) in Main AI Core Flow.json (tracked, pushed). Rotation is an owner action.`,
});

const unscoped = (name: string) => {
  const s = hubSql(name);
  return /ticket_number = \$1/.test(s) && !/conversation_id|identity_id|project_id/.test(s);
};
gap({
  id: "G-P0-2", priority: "P0", pm1: "1,14,22 (status by ticket number)",
  what: "Hub step_get_status / step_update_summary look a ticket up by number only (no conversation/identity/project scope)",
  present: unscoped("step_get_status") || unscoped("step_update_summary"),
  evidence: `get_status unscoped=${unscoped("step_get_status")}, update_summary unscoped=${unscoped("step_update_summary")}; step_find_ticket/step_list_tickets are scoped`,
});

const credRule = /password|รหัสผ่าน|credential|OTP/i;
gap({
  id: "G-P0-3", priority: "P0", pm1: "23,24,25",
  what: "no prompt rule: never ask for, repeat, reset or issue a password/credential; hand off instead",
  present: !credRule.test(gatePrompt) && !credRule.test(customerPrompt),
  evidence: "0 matches for password|รหัสผ่าน|credential|OTP in gate and customer prompts",
});

gap({
  id: "G-P0-4", priority: "P0", pm1: "37",
  what: "no prompt rule against confirming another person's account existence or role/approval level",
  present: !/(บัญชี|account)[^\n]{0,120}(บุคคลอื่น|คนอื่น|another person|someone else|other (user|person))/i.test(customerPrompt + gatePrompt),
  evidence: "no account-disclosure rule in gate or customer prompt (T10 shows no lookup TOOL exists; the model can still answer from text)",
});

gap({
  id: "G-P0-5", priority: "P0", pm1: "39",
  what: "no gate intent for server/infrastructure/'stop the system or AI' requests (only explicit human request or frustration escalates)",
  present: !/server|เซิร์ฟเวอร์|infrastructure|stop the (system|ai|bot)|หยุด(ระบบ|AI|บอท)/i.test(gatePrompt),
  evidence: "0 matches in gate prompt; escalate_to_pm enum has SAFETY_REVIEW but the flow never uses it",
});

gap({
  id: "G-P0-6", priority: "P0", pm1: "20,22 (human support active)",
  what: "LINE webhook fast-ack/forward path has no takeover (handled_by) check",
  present: !/handled_by|takeover_state|takeoverManager/i.test(stripComments(lineWebhookSrc)),
  evidence: "no handled_by/takeover reference in lineWebhook.ts code; the flow checks handled_by once before the LLM, not before the push",
});

gap({
  id: "G-P1-1", priority: "P1", pm1: "16,17,30,36",
  what: "one gate turn yields ONE ticket_action/ticket_id/subject; a multi-issue message cannot be split",
  present: /OUTPUT: the JSON object only/.test(gatePrompt) && !/"tickets"\s*:\s*\[/.test(gatePrompt),
  evidence: "gate OUTPUT spec is a single object",
});

gap({
  id: "G-P1-2", priority: "P1", pm1: "30,34",
  what: "no per-issue state inside a ticket (A pass / B fail / C pass needs three tickets)",
  present: !/ticket_items|sub_issue|ticket_issues|issue_items/i.test(migrationsSql),
  evidence: "no sub-issue table in database/migrations",
});

gap({
  id: "G-P1-3", priority: "P1", pm1: "2,13,14,15,24,36",
  what: "reporter != affected user is not modelled (coordinator reports for someone else)",
  present: !/affected_user|on_behalf|reported_for|affected_party/i.test(migrationsSql),
  evidence: "no such column in database/migrations; policy is an owner decision (VERIFY-015)",
});

gap({
  id: "G-P1-4", priority: "P1", pm1: "3,10,20,35",
  what: "no explicit prompt rule against speculating on a root cause",
  present: !/(never|do not|don't)[^\n]{0,40}(speculat|guess)[^\n]{0,60}(cause|สาเหตุ|why)/i.test(customerPrompt),
  evidence: "GROUNDING covers ticket facts/dates, not causes",
});

gap({
  id: "G-P2-1", priority: "P2", pm1: "29,34,39",
  what: "after-hours: project_business_hours is not used in customer replies",
  present: !/business_hours|นอกเวลา/i.test(customerPrompt + gatePrompt),
  evidence: "no reference in either prompt; behaviour is an owner decision (VERIFY-007)",
});

// ===========================================================================
// NEEDS_VERIFICATION — not asserted; see .ai/PM1_VERIFICATION_QUESTIONS.md
// ===========================================================================
const needsVerification = [
  "VERIFY-001 silence handling beyond the delivered-case auto-close (enable SLA_CADENCE in production?)",
  "VERIFY-003 authorised human password-reset process",
  "VERIFY-004 who may disclose account existence / role",
  "VERIFY-005 how much root cause the AI may tell customers",
  "VERIFY-008 incident / server-emergency protocol",
  "VERIFY-009 one message with several resolutions",
  "VERIFY-015 reporter != affected user: who is the ticket's customer",
];

// ===========================================================================
// Report
// ===========================================================================
console.log("PM1 behavioural contract (source: docs/PM1_UAT_Support_Chat_แยกตามเคส.md — PM1 ≠ TicketX)\n");
console.log("CONTRACT");
for (const c of contract) {
  console.log(`  ${c.ok ? "ผ่าน" : "พลาด"}  ${c.id.padEnd(5)} [PM1 ${c.pm1}] ${c.what}${!c.ok && c.detail ? `  (${c.detail})` : ""}`);
}

console.log("\nKNOWN GAP (ไม่ทำให้ suite แดง — เตือนถ้าสถานะเปลี่ยน)");
const changed: Gap[] = [];
for (const g of gaps) {
  if (!g.present) changed.push(g);
  console.log(`  ${g.present ? "ยังอยู่ " : "** เปลี่ยน **"} ${g.id} ${g.priority} [PM1 ${g.pm1}] ${g.what}`);
  console.log(`        ${g.evidence}`);
}

console.log("\nNEEDS_VERIFICATION (BLOCKED — OWNER DECISION REQUIRED, not asserted)");
needsVerification.forEach((v) => console.log("  " + v));

const failed = contract.filter((c) => !c.ok);
console.log("\n" + "=".repeat(100));
console.log(`CONTRACT ${contract.length - failed.length}/${contract.length}  |  KNOWN GAP ${gaps.filter((g) => g.present).length}/${gaps.length} still present`);
if (changed.length) {
  console.log("\nสถานะ gap เปลี่ยน — ตรวจสอบ แล้วเลื่อนขึ้นเป็น CONTRACT ถ้าแก้แล้ว:");
  changed.forEach((g) => console.log(`  ${g.id} ${g.what}`));
}
if (failed.length) {
  console.log(`\nCONTRACT พลาด ${failed.length}:`);
  failed.forEach((c) => console.log(`  ${c.id} ${c.what}  (${c.detail ?? ""})`));
  process.exit(1);
}
console.log("CONTRACT ผ่านทั้งหมด");
