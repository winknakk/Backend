/**
 * Demo 3.4 — delivered case, silent customer: one reminder after
 * RESOLUTION_NUDGE_BUSINESS_DAYS, auto-close after
 * RESOLUTION_AUTO_CLOSE_BUSINESS_DAYS (business days, Mon–Fri Bangkok).
 *
 * Runs the REAL SLACadenceService.evaluateOpenTickets against an in-memory
 * fake of the tables it touches (tickets, sla_cadence_claims); LINE sends,
 * the state machine (real canTransition rules) and the Done email are stubbed.
 * No infrastructure needed:
 *
 *   npx tsx src/test-sla-resolution-followups.ts
 */

import { pool } from "./adapters/postgres/PostgresAdapter";
import { config } from "./config/env";
import { canTransition, type TicketLifecycleStatus } from "./domain/ticket/TicketLifecycle";
import { ticketStateMachine } from "./domain/ticket/TicketStateMachine";
import { ConstantSystemService } from "./services/ConstantSystemService";
import { customerNotificationService } from "./services/CustomerNotificationService";
import { SLACadenceService } from "./services/SLACadenceService";
import { doneEmailService } from "./services/UrgentAlertService";

// ---------------------------------------------------------------------------
// In-memory world
// ---------------------------------------------------------------------------

interface Ticket {
  id: number;
  ticket_number: string;
  subject: string;
  status: string;
  waiting_since: Date;
  conversation_id: number;
  handled_by: string;
  takeover_state: string;
}
interface Sent { type: string; ticketId: number; detail: string }
interface Hop { ticketId: number; to: string; actor: string }

let tickets: Ticket[] = [];
let claims = new Map<string, { id: number; status: string }>();
let sent: Sent[] = [];
let hops: Hop[] = [];
let doneEmails: number[] = [];
let failNextSend = false;
let seq = 1;

function reset() {
  tickets = [];
  claims = new Map();
  sent = [];
  hops = [];
  doneEmails = [];
  failNextSend = false;
}

/** Bangkok wall-clock → Date. */
const bkk = (iso: string) => new Date(`${iso}+07:00`);

function addTicket(n: number, status: string, waitingSince: string, extra: Partial<Ticket> = {}): Ticket {
  const t: Ticket = {
    id: 7000 + n,
    ticket_number: `TCK-2026-7000${n}`,
    subject: "ระบบชดใช้เงินยืม - ย้อนสถานะไม่ได้",
    status,
    waiting_since: bkk(waitingSince),
    conversation_id: 5000 + n,
    handled_by: "ai",
    takeover_state: "none",
    ...extra,
  };
  tickets.push(t);
  return t;
}

const fakeQuery = async (sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> => {
  const s = String(sql);
  const out = (rows: any[]) => ({ rows, rowCount: rows.length });
  if (/IN \('RESOLVED', 'CUSTOMER_CONFIRMED'\)/.test(s)) {
    return out(
      tickets
        .filter((t) => t.status === "RESOLVED" || t.status === "CUSTOMER_CONFIRMED")
        .map((t) => ({ ...t, project_id: 1, org_id: "org_test" }))
    );
  }
  if (/FROM tickets t\s+LEFT JOIN projects/.test(s)) return out([]); // no SLA-cadence open tickets in this test
  if (/INSERT INTO sla_cadence_claims/.test(s)) {
    const key = `${params[0]}|${params[1]}|${params[2]}`;
    if (claims.has(key)) return out([]);
    const id = seq++;
    claims.set(key, { id, status: "pending" });
    return out([{ id }]);
  }
  if (/UPDATE sla_cadence_claims/.test(s)) {
    for (const c of claims.values()) if (c.id === Number(params[0])) c.status = String(params[1]);
    return out([]);
  }
  if (/DELETE FROM sla_cadence_claims/.test(s)) {
    for (const [k, c] of claims) if (c.id === Number(params[0])) claims.delete(k);
    return out([]);
  }
  return out([]);
};
(pool as any).query = fakeQuery;
(pool as any).connect = async () => ({
  query: async (sql: string) => (/pg_try_advisory_lock/.test(sql) ? { rows: [{ ok: true }] } : { rows: [] }),
  release: () => {},
});

(customerNotificationService as any).send = async (req: any) => {
  if (failNextSend) {
    failNextSend = false;
    throw new Error("LINE push timeout (simulated)");
  }
  sent.push({ type: req.notificationType, ticketId: Number(req.ticketId), detail: String(req.detail || "") });
  return { sent: true };
};
(customerNotificationService as any).retryFailed = async () => 0;
(ticketStateMachine as any).transition = async (req: any) => {
  const t = tickets.find((x) => x.id === Number(req.ticketRef));
  if (!t) return { applied: false, code: "TICKET_NOT_FOUND" };
  const check = canTransition(t.status as TicketLifecycleStatus, req.to, req.actor);
  if (!check.allowed) return { applied: false, code: check.code };
  hops.push({ ticketId: t.id, to: req.to, actor: req.actor });
  t.status = req.to;
  return { applied: true, eventId: seq++ };
};
(doneEmailService as any).notifyClosed = async (req: any) => {
  doneEmails.push(Number(req.ticketId));
};
(ConstantSystemService as any).getConstant = async (_key: string, fallback: string) => fallback;

// The operator's defaults: reminder after 1 business day, close after 3.
(config as any).RESOLUTION_NUDGE_BUSINESS_DAYS = 1;
(config as any).RESOLUTION_AUTO_CLOSE_BUSINESS_DAYS = 3;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passes = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "ผ่าน" : "พลาด"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
}

const engine = new SLACadenceService({ maxSendsPerRun: 50 });
const run = (at: string, dryRun?: boolean) => engine.evaluateOpenTickets(bkk(at), dryRun === undefined ? {} : { dryRun });
const typesFor = (t: Ticket) => sent.filter((x) => x.ticketId === t.id).map((x) => x.type);

async function main() {
  // Mon 2026-09-28 10:00 delivered → nudge Tue 10:00 → auto-close Thu 10:00.
  console.log("\nS1 — the normal silent-customer timeline (delivered Monday 10:00)");
  reset();
  const A = addTicket(1, "RESOLVED", "2026-09-28T10:00:00");
  let r = await run("2026-09-28T15:00:00");
  check("S1a same day: nothing is sent", sent.length === 0 && A.status === "RESOLVED" && r.awaitingEvaluated === 1, JSON.stringify(sent));
  r = await run("2026-09-29T09:59:00");
  check("S1b 1 minute before 1 business day: still nothing", sent.length === 0, JSON.stringify(sent));
  r = await run("2026-09-29T10:01:00");
  check("S1c after 1 business day: one reminder (resolution_nudge)", r.nudgesSent === 1 && typesFor(A).join() === "resolution_nudge" && A.status === "RESOLVED", JSON.stringify(sent));
  check("S1d the reminder tells the customer when it will auto-close", /ปิดเคสให้อัตโนมัติ/.test(sent[0]?.detail || ""), sent[0]?.detail);
  r = await run("2026-09-30T11:00:00");
  check("S1e next passes do not remind again", typesFor(A).length === 1, JSON.stringify(typesFor(A)));
  r = await run("2026-10-01T10:01:00");
  check("S1f after 3 business days: auto-closed", r.autoClosed === 1 && A.status === "CLOSED", `status=${A.status} result=${JSON.stringify(r)}`);
  check("S1g walks RESOLVED → CUSTOMER_CONFIRMED → CLOSED as the system", hops.map((h) => `${h.to}/${h.actor}`).join() === "CUSTOMER_CONFIRMED/system,CLOSED/system", JSON.stringify(hops));
  check("S1h the customer is told (auto_closed) and the Done email goes out", typesFor(A).includes("auto_closed") && doneEmails.includes(A.id), `${JSON.stringify(typesFor(A))} emails=${JSON.stringify(doneEmails)}`);
  r = await run("2026-10-02T10:00:00");
  check("S1i a closed case is left alone afterwards", typesFor(A).length === 2 && hops.length === 2, JSON.stringify(typesFor(A)));

  console.log("\nS2 — weekends do not count (delivered Friday 16:00)");
  reset();
  const B = addTicket(2, "RESOLVED", "2026-10-02T16:00:00");
  await run("2026-10-04T16:01:00");
  check("S2a Sunday: nothing yet (weekend is not a business day)", sent.length === 0, JSON.stringify(sent));
  await run("2026-10-05T16:01:00");
  check("S2b Monday 16:01: the reminder", typesFor(B).join() === "resolution_nudge", JSON.stringify(typesFor(B)));
  await run("2026-10-06T16:01:00");
  check("S2c Tuesday: still open", B.status === "RESOLVED", B.status);
  await run("2026-10-07T16:01:00");
  check("S2d Wednesday 16:01 (3rd business day): auto-closed", B.status === "CLOSED", B.status);

  console.log("\nS3 — a customer who said 'ใช้งานได้แล้ว' but never tapped close");
  reset();
  const C = addTicket(3, "CUSTOMER_CONFIRMED", "2026-09-28T10:00:00");
  await run("2026-10-01T10:01:00");
  check("S3a CUSTOMER_CONFIRMED closes in one hop", C.status === "CLOSED" && hops.map((h) => h.to).join() === "CLOSED", JSON.stringify(hops));

  console.log("\nS4 — a human owns the chat");
  reset();
  const D = addTicket(4, "RESOLVED", "2026-09-28T10:00:00", { handled_by: "human" });
  const D2 = addTicket(5, "RESOLVED", "2026-09-28T10:00:00", { takeover_state: "active" });
  await run("2026-09-29T10:01:00");
  await run("2026-10-01T10:01:00");
  check("S4a no reminder and no auto-close while staff handle the conversation", sent.length === 0 && D.status === "RESOLVED" && D2.status === "RESOLVED", `${JSON.stringify(sent)} ${D.status}/${D2.status}`);

  console.log("\nS5 — overdue when the engine starts: closes, no reminder first");
  reset();
  const E = addTicket(6, "RESOLVED", "2026-09-21T10:00:00");
  await run("2026-09-28T10:00:00");
  check("S5a a case waiting 5 business days is closed without a late reminder", E.status === "CLOSED" && !typesFor(E).includes("resolution_nudge"), JSON.stringify(typesFor(E)));

  console.log("\nS6 — reopen and redeliver restarts the clock");
  reset();
  const F = addTicket(7, "RESOLVED", "2026-09-28T10:00:00");
  await run("2026-09-29T10:01:00");
  F.waiting_since = bkk("2026-09-30T14:00:00"); // reopened, then delivered again Wednesday 14:00
  await run("2026-10-01T10:01:00");
  check("S6a the old deadline no longer closes it", F.status === "RESOLVED", F.status);
  await run("2026-10-01T14:01:00");
  check("S6b the new cycle gets its own reminder", typesFor(F).filter((x) => x === "resolution_nudge").length === 2, JSON.stringify(typesFor(F)));
  await run("2026-10-05T14:01:00");
  check("S6c ...and closes 3 business days after the new delivery", F.status === "CLOSED", F.status);

  console.log("\nS7 — dry run and a failed push");
  reset();
  const G = addTicket(8, "RESOLVED", "2026-09-28T10:00:00");
  const dry = await run("2026-10-01T10:01:00", true);
  check("S7a dry run reports the close but changes nothing", dry.autoClosed === 1 && G.status === "RESOLVED" && sent.length === 0 && claims.size === 0, `${JSON.stringify(dry)} ${G.status}`);
  reset();
  const H = addTicket(9, "RESOLVED", "2026-09-28T10:00:00");
  failNextSend = true;
  await run("2026-09-29T10:01:00");
  check("S7b a failed reminder push releases its slot", sent.length === 0 && claims.size === 0, `claims=${claims.size}`);
  await run("2026-09-29T10:16:00");
  check("S7c ...and the next pass sends it", typesFor(H).join() === "resolution_nudge", JSON.stringify(typesFor(H)));

  console.log(`\n${passes} ผ่าน, ${failures} พลาด`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
