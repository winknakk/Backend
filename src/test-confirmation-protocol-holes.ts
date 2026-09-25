/**
 * Regression guard for the customer confirmation protocol holes H1–H10
 * (2026-09-24). Runs the REAL CustomerConfirmationHandler against an
 * in-memory fake of the few tables it reads (tickets, customer_notifications,
 * messages); sending, the state machine and focus are stubbed so nothing
 * leaves the process. No infrastructure needed:
 *
 *   npx tsx src/test-confirmation-protocol-holes.ts
 *
 * Each scenario is a short chat, written the way a customer types it.
 */

import { pool } from "./adapters/postgres/PostgresAdapter";
import { canTransition, type TicketLifecycleStatus } from "./domain/ticket/TicketLifecycle";
import { ticketStateMachine } from "./domain/ticket/TicketStateMachine";
import { conversationFocusService } from "./services/ConversationFocusService";
import { customerNotificationService, CustomerNotificationService } from "./services/CustomerNotificationService";
import { cancelAlertService, doneEmailService, reopenAlertService } from "./services/UrgentAlertService";
import { customerConfirmationHandler } from "./services/CustomerConfirmationHandler";
import { detectReopenScope, isBareShortAnswer, isDeclineReopen, isExplicitDeclineCancel, isExplicitDeclineClose } from "./domain/ticket/CustomerConfirmation";

// ---------------------------------------------------------------------------
// In-memory world
// ---------------------------------------------------------------------------

interface Ticket {
  id: number;
  conversation_id: number;
  ticket_number: string;
  subject: string;
  status: string;
  priority: string | null;
  project_id: number | null;
  org_id: string | null;
  reopened_count: number | null;
  last_reopened_at: Date | null;
  closed_at: Date | null;
  lifecycle_changed_at: Date;
}
interface Notification { id: number; conversation_id: number; ticket_id: number | null; notification_type: string; status: string; created_at: Date; quickReplies: { label: string; text: string }[] }
interface Message { id: number; conversation_id: number; role: string; content: string; message_purpose: string | null; created_at: Date }

const CONV = 424242;
let clock = Date.now() - 20 * 60_000;
const tick = () => new Date((clock += 1000));
let tickets: Ticket[] = [];
let notifications: Notification[] = [];
let messages: Message[] = [];
let seq = 1;
let refuseNext: string | null = null;

function reset() {
  tickets = [];
  notifications = [];
  messages = [];
  refuseNext = null;
  clock = Date.now() - 20 * 60_000;
}

function addTicket(n: number, status: string, subject: string, extra: Partial<Ticket> = {}): Ticket {
  const t: Ticket = {
    id: 9000 + n,
    conversation_id: CONV,
    ticket_number: `TCK-2026-1000${n}`,
    subject,
    status,
    priority: "MEDIUM",
    project_id: 1,
    org_id: "org_test",
    reopened_count: 0,
    last_reopened_at: null,
    closed_at: null,
    lifecycle_changed_at: tick(),
    ...extra,
  };
  tickets.push(t);
  return t;
}

/** What the AI flow said (a real reply row, not a backend notification). */
function aiSays(content: string) {
  messages.push({ id: seq++, conversation_id: CONV, role: "ai", content, message_purpose: null, created_at: tick() });
}

/** A backend notification that was sent (Fast Ack, SLA progress, a question…). */
function botNotifies(type: string, ticket: Ticket | null, quickReplies: { label: string; text: string }[] = []) {
  notifications.push({ id: seq++, conversation_id: CONV, ticket_id: ticket?.id ?? null, notification_type: type, status: "sent", created_at: tick(), quickReplies });
  messages.push({ id: seq++, conversation_id: CONV, role: "ai", content: `[${type}]`, message_purpose: "notification", created_at: tick() });
}

const numberOf = (id: number | null) => tickets.find((t) => t.id === id)?.ticket_number ?? null;

const fakeQuery = async (sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> => {
  const s = String(sql);
  const out = (rows: any[]) => ({ rows, rowCount: rows.length });
  const byConv = tickets.filter((t) => t.conversation_id === Number(params[0]));
  if (/FROM tickets/.test(s) && /NOT IN \('CLOSED', 'CANCELLED'\)/.test(s) && /conversation_id = \$1/.test(s)) {
    return out(byConv.filter((t) => !["CLOSED", "CANCELLED"].includes(t.status)).sort((a, b) => b.lifecycle_changed_at.getTime() - a.lifecycle_changed_at.getTime()));
  }
  if (/FROM tickets/.test(s) && /= 'CLOSED'/.test(s) && /closed_at >=/.test(s)) {
    const days = Number(params[1]);
    return out(byConv.filter((t) => t.status === "CLOSED" && t.closed_at && Date.now() - t.closed_at.getTime() <= days * 86_400_000));
  }
  if (/UPPER\(ticket_number\) = \$2/.test(s)) {
    return out(byConv.filter((t) => t.ticket_number.toUpperCase() === String(params[1]) && ["CLOSED", "CANCELLED"].includes(t.status)));
  }
  if (/FROM customer_notifications n/.test(s) && /<> ALL/.test(s)) {
    const passive: string[] = params[2];
    const row = notifications.filter((n) => n.conversation_id === Number(params[0]) && n.status === "sent" && !passive.includes(n.notification_type)).pop();
    return out(row ? [{ notification_type: row.notification_type, ticket_number: numberOf(row.ticket_id), created_at: row.created_at }] : []);
  }
  if (/n\.notification_type = \$3/.test(s)) {
    const t = tickets.find((x) => x.id === Number(params[1]));
    const hit = notifications.some(
      (n) => n.conversation_id === Number(params[0]) && n.ticket_id === Number(params[1]) && n.notification_type === params[2] && n.status === "sent" && t && n.created_at >= t.lifecycle_changed_at
    );
    return out(hit ? [{ "?column?": 1 }] : []);
  }
  if (/POSITION\(UPPER\(\$4\)/.test(s)) {
    const t = tickets.find((x) => x.id === Number(params[1]));
    return out(
      messages
        .filter((m) => m.conversation_id === Number(params[0]) && m.role === "ai" && m.message_purpose !== "notification" && t && m.created_at >= t.lifecycle_changed_at && m.content.toUpperCase().includes(String(params[3]).toUpperCase()))
        .reverse()
        .slice(0, 5)
    );
  }
  if (/FROM messages/.test(s) && /role = 'ai'/.test(s) && /message_purpose/.test(s)) {
    const row = messages.filter((m) => m.conversation_id === Number(params[0]) && m.role === "ai" && m.message_purpose !== "notification").pop();
    return out(row ? [{ content: row.content, created_at: row.created_at }] : []);
  }
  if (/COUNT\(\*\) AS n FROM ticket_events/.test(s)) return out([{ n: "0" }]);
  if (/SELECT UPPER\(COALESCE\(status/.test(s)) {
    const t = tickets.find((x) => x.id === Number(params[0]));
    return out(t ? [{ status: t.status }] : []);
  }
  return out([]); // INSERT / UPDATE side effects are not modelled
};
(pool as any).query = fakeQuery;
// Imports run before any statement here, so the pool already points at the
// configured server: it must never open a connection from this test.
(pool as any).connect = async () => {
  throw new Error("test-confirmation-protocol-holes must not connect to a real database");
};

// Stubs: nothing leaves the process.
(customerNotificationService as any).send = async (req: any) => {
  const quickReplies = req.quickReplies ?? CustomerNotificationService.defaultQuickReplies(req.notificationType, req.ticketNumber);
  botNotifies(req.notificationType, req.ticketId ? tickets.find((t) => t.id === Number(req.ticketId)) ?? null : null, quickReplies);
  notifications[notifications.length - 1].quickReplies = quickReplies;
  return { sent: true };
};
(ticketStateMachine as any).transition = async (req: any) => {
  const t = tickets.find((x) => x.id === Number(req.ticketRef));
  if (!t) return { applied: false, code: "TICKET_NOT_FOUND" };
  if (refuseNext && refuseNext === req.to) {
    refuseNext = null;
    return { applied: false, code: "INVALID_TRANSITION" };
  }
  const check = canTransition(t.status as TicketLifecycleStatus, req.to, req.actor);
  if (!check.allowed) return { applied: false, code: check.code };
  t.status = req.to;
  t.lifecycle_changed_at = tick();
  if (req.to === "CLOSED") t.closed_at = t.lifecycle_changed_at;
  if (req.to === "REOPENED") {
    t.reopened_count = (t.reopened_count || 0) + 1;
    t.last_reopened_at = t.lifecycle_changed_at;
  }
  return { applied: true, eventId: seq++ };
};
(conversationFocusService as any).getActiveTicketId = async () => null;
(conversationFocusService as any).releaseTerminalTicket = async () => ({ cleared: 0, refocusedTo: null });
for (const svc of [doneEmailService, cancelAlertService, reopenAlertService] as any[]) {
  for (const k of ["notifyClosed", "notifyCancelled", "notifyReopened"]) svc[k] = async () => {};
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "ผ่าน" : "พลาด"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
}

/** The customer types / taps `text`; returns the handler outcome and the bot's new messages. */
async function customer(text: string) {
  messages.push({ id: seq++, conversation_id: CONV, role: "customer", content: text, message_purpose: null, created_at: tick() });
  const before = notifications.length;
  const outcome = await customerConfirmationHandler.handle({ conversationId: CONV, text, correlationId: `evt-${seq++}` });
  return { outcome, sent: notifications.slice(before) };
}

const types = (sent: Notification[]) => sent.map((n) => `${n.notification_type}${n.ticket_id ? `(${numberOf(n.ticket_id)})` : ""}`).join(", ") || "(nothing)";

async function main() {
  if ((pool as any).query !== fakeQuery) {
    console.error("Refusing to run: the in-memory database fake is not installed.");
    process.exit(1);
  }
  // -------------------------------------------------------------------------
  console.log("\nH1 — a numbered chip never acts on a different case");
  reset();
  let A = addTicket(1, "CLOSED", "เข้าระบบไม่ได้", { closed_at: new Date(Date.now() - 2 * 86_400_000) });
  let B = addTicket(2, "RESOLVED", "ใบเสร็จไม่ขึ้น");
  let r = await customer(`ยังมีปัญหาอยู่ ${A.ticket_number}`);
  check("H1a 'ยังมีปัญหาอยู่ A' (A closed 2 days) asks same/new about A", r.sent[0]?.notification_type === "reopen_which_kind" && r.sent[0]?.ticket_id === A.id, types(r.sent));
  r = await customer(`ปัญหาใหม่ ${A.ticket_number}`);
  check("H1b 'ปัญหาใหม่ A' asks for the new report", r.sent[0]?.notification_type === "new_case_prompt", types(r.sent));
  check("H1c ...and B (RESOLVED, unrelated) is left alone", B.status === "RESOLVED", `B is ${B.status}`);

  reset();
  A = addTicket(1, "IN_PROGRESS", "เข้าระบบไม่ได้");
  B = addTicket(2, "RESOLVED", "ใบเสร็จไม่ขึ้น");
  r = await customer(`ใช้งานได้แล้ว ${A.ticket_number}`);
  check("H1d 'ใช้งานได้แล้ว A' (A pulled back to IN_PROGRESS) asks to close A, not B", r.sent[0]?.notification_type === "close_confirmation_request" && r.sent[0]?.ticket_id === A.id, types(r.sent));
  r = await customer(`ยังมีปัญหาอยู่ ${A.ticket_number}`);
  check("H1e 'ยังมีปัญหาอยู่ A' (A in progress) answers about A only", r.sent[0]?.notification_type === "case_context" && r.sent[0]?.ticket_id === A.id && B.status === "RESOLVED", types(r.sent));

  reset();
  B = addTicket(2, "RESOLVED", "ใบเสร็จไม่ขึ้น");
  const C = addTicket(3, "RESOLVED", "หน้ารายงานจอขาว");
  r = await customer("ใช้ได้แล้วครับ");
  const chips = r.sent[0]?.quickReplies.map((q) => q.text) || [];
  check("H1f two delivered cases + unnumbered 'ใช้ได้แล้ว' asks which case", r.sent[0]?.notification_type === "resolution_which_case" && chips.includes(`ใช้งานได้แล้ว ${B.ticket_number}`) && chips.includes(`ใช้งานได้แล้ว ${C.ticket_number}`), `${types(r.sent)} ${JSON.stringify(chips)}`);
  check("H1g ...and changes neither case", B.status === "RESOLVED" && C.status === "RESOLVED");

  // -------------------------------------------------------------------------
  console.log("\nH2 — at the 'same or new?' question only a symptom re-opens");
  reset();
  B = addTicket(2, "RESOLVED", "ใบเสร็จไม่ขึ้น");
  r = await customer("ยังมีปัญหาอยู่ครับ");
  check("H2a 'ยังมีปัญหาอยู่' asks same/new", r.sent[0]?.notification_type === "reopen_which_kind", types(r.sent));
  r = await customer("อ๋อ ลองล้าง cache แล้ว ใช้งานได้แล้วค่ะ");
  check("H2b 'ใช้งานได้แล้ว' there asks the close question", r.sent[0]?.notification_type === "close_confirmation_request", types(r.sent));
  check("H2c ...and does NOT re-open", B.status !== "REOPENED", `B is ${B.status}`);

  reset();
  B = addTicket(2, "RESOLVED", "ใบเสร็จไม่ขึ้น");
  await customer("ยังมีปัญหาอยู่ครับ");
  r = await customer("ขอคุยกับเจ้าหน้าที่หน่อยค่ะ");
  check("H2d 'ขอคุยกับเจ้าหน้าที่' there goes to the AI, case untouched", r.outcome.handled === false && B.status === "RESOLVED", `${JSON.stringify(r.outcome)} B=${B.status}`);
  r = await customer("หน้าจอยังขึ้น error 500 อยู่เลยค่ะ");
  check("H2e a described symptom there re-opens (AD-08 kept)", B.status === "REOPENED", `B is ${B.status}; ${types(r.sent)}`);

  // -------------------------------------------------------------------------
  console.log("\nH3 — a bare 'ใช่' at the 'same or new?' question never closes");
  reset();
  B = addTicket(2, "RESOLVED", "ใบเสร็จไม่ขึ้น");
  await customer(`ใช้งานได้แล้ว ${B.ticket_number}`); // → CUSTOMER_CONFIRMED + close question
  await customer("เอ๊ะ เดี๋ยวนะ ยังมีปัญหาอยู่ค่ะ"); // → same/new question
  r = await customer("ใช่ค่ะ");
  check("H3a 'ใช่ค่ะ' asks same/new again", r.sent[0]?.notification_type === "reopen_which_kind", types(r.sent));
  check("H3b ...and the case is neither closed nor re-opened", B.status === "CUSTOMER_CONFIRMED", `B is ${B.status}`);

  // -------------------------------------------------------------------------
  console.log("\nH4 — 'ยังไม่ปิด' works whatever the subject length");
  reset();
  B = addTicket(2, "RESOLVED", "ระบบชดใช้เงินยืม - ขอย้อนสถานะเอกสารสัญญาเงินยืมเลขที่ 69/0123 กลับไปแก้ไขให้ถูกต้องตามที่ฝ่ายบัญชีแจ้งมา");
  await customer(`ใช้งานได้แล้ว ${B.ticket_number}`);
  r = await customer("ยังไม่ปิด");
  check("H4a long subject: 'ยังไม่ปิด' is understood", r.sent[0]?.notification_type === "close_declined", types(r.sent));
  check("H4b ...and the case goes back to RESOLVED", B.status === "RESOLVED", `B is ${B.status}`);
  check("H4c Fast Ack for a stray 'ยังไม่ปิด' is the choice receipt", CustomerNotificationService.classifyAcknowledgement("ยังไม่ปิด") === "acknowledgement_choice");

  // -------------------------------------------------------------------------
  console.log("\nH5 — 'ไม่ยกเลิก' survives messages in between");
  reset();
  let D = addTicket(4, "IN_PROGRESS", "ขอเพิ่มสิทธิ์ผู้ใช้");
  await customer(`ขอยกเลิกเคส ${D.ticket_number} ค่ะ`);
  await customer("เดี๋ยวขอถามหัวหน้าก่อนนะคะ");
  botNotifies("acknowledgement", null);
  aiSays("ได้เลยค่ะ ถามหัวหน้าแล้วแจ้งกลับมาได้เลยนะคะ");
  r = await customer("หัวหน้าบอกไม่ยกเลิกค่ะ".replace("หัวหน้าบอก", ""));
  check("H5a after a Fast Ack + AI reply, 'ไม่ยกเลิกค่ะ' is still the cancel decline", r.sent[0]?.notification_type === "cancel_declined", types(r.sent));

  reset();
  D = addTicket(4, "IN_PROGRESS", "ขอเพิ่มสิทธิ์ผู้ใช้");
  await customer(`ขอยกเลิกเคส ${D.ticket_number} ค่ะ`);
  botNotifies("progress_update", D, CustomerNotificationService.defaultQuickReplies("cancel_confirmation_request", D.ticket_number));
  r = await customer("ไม่ยกเลิก");
  check("H5b the sticky chip on an SLA progress update works", r.sent[0]?.notification_type === "cancel_declined" && D.status === "IN_PROGRESS", types(r.sent));

  // -------------------------------------------------------------------------
  console.log("\nH6 — a refused transition is answered, never handed to the AI");
  reset();
  D = addTicket(4, "IN_PROGRESS", "ขอเพิ่มสิทธิ์ผู้ใช้");
  await customer(`ขอยกเลิกเคส ${D.ticket_number} ค่ะ`);
  refuseNext = "CANCELLED";
  r = await customer(`ยืนยันยกเลิกเคส ${D.ticket_number}`);
  check("H6a refused cancel → handled + action_failed", r.outcome.handled === true && r.sent[0]?.notification_type === "action_failed", `${JSON.stringify(r.outcome)} ${types(r.sent)}`);

  reset();
  D = addTicket(4, "IN_PROGRESS", "ขอเพิ่มสิทธิ์ผู้ใช้");
  await customer(`ขอยกเลิกเคส ${D.ticket_number} ค่ะ`);
  D.status = "RESOLVED"; // engineering delivered it a moment ago; the handler still holds IN_PROGRESS
  const loadOpen = (customerConfirmationHandler as any).loadOpenTickets.bind(customerConfirmationHandler);
  (customerConfirmationHandler as any).loadOpenTickets = async (id: number) => (await loadOpen(id)).map((t: any) => ({ ...t, status: "IN_PROGRESS" }));
  r = await customer(`ยืนยันยกเลิกเคส ${D.ticket_number}`);
  (customerConfirmationHandler as any).loadOpenTickets = loadOpen;
  check("H6b cancel refused because it was just delivered → offers the close question", r.outcome.handled === true && r.sent[0]?.notification_type === "close_confirmation_request", `${JSON.stringify(r.outcome)} ${types(r.sent)}`);

  // -------------------------------------------------------------------------
  console.log("\nH7 — timeout fallback delay (config)");
  const { config } = await import("./config/env");
  check("H7a AI_TIMEOUT_FALLBACK_AFTER_MS defaults to 30 minutes", config.AI_TIMEOUT_FALLBACK_AFTER_MS === 30 * 60 * 1000 || Boolean(process.env.AI_TIMEOUT_FALLBACK_AFTER_MS), String(config.AI_TIMEOUT_FALLBACK_AFTER_MS));

  // -------------------------------------------------------------------------
  console.log("\nH8 — typed confirmations need the question first");
  reset();
  let E = addTicket(5, "IN_PROGRESS", "ส่งอีเมลไม่ได้");
  r = await customer(`ยืนยันปิดเคส ${E.ticket_number}`);
  check("H8a typed 'ยืนยันปิดเคส' with no question asks first", r.sent[0]?.notification_type === "close_confirmation_request" && E.status === "IN_PROGRESS", `${types(r.sent)} E=${E.status}`);
  r = await customer(`ยืนยันปิดเคส ${E.ticket_number}`);
  check("H8b ...answering that question closes it", E.status === "CLOSED", `E is ${E.status}`);

  reset();
  E = addTicket(5, "RESOLVED", "ส่งอีเมลไม่ได้");
  aiSays(`ต้องการปิดเคส ${E.ticket_number} เรื่อง "ส่งอีเมลไม่ได้" ใช่ไหมคะ แตะ 'ยืนยันปิดเคส' ได้เลยค่ะ`);
  r = await customer(`ยืนยันปิดเคส ${E.ticket_number}`);
  check("H8c a close question asked by the AI flow counts", E.status === "CLOSED", `E is ${E.status}; ${types(r.sent)}`);

  reset();
  E = addTicket(5, "IN_PROGRESS", "ส่งอีเมลไม่ได้");
  r = await customer(`ยืนยันยกเลิกเคส ${E.ticket_number}`);
  check("H8d typed 'ยืนยันยกเลิกเคส' with no question asks first", r.sent[0]?.notification_type === "cancel_confirmation_request" && E.status === "IN_PROGRESS", `${types(r.sent)} E=${E.status}`);

  reset();
  E = addTicket(5, "RESOLVED", "ส่งอีเมลไม่ได้");
  await customer(`ใช้งานได้แล้ว ${E.ticket_number}`);
  E.lifecycle_changed_at = tick(); // engineering moved it after the question
  E.status = "REOPENED";
  r = await customer(`ยืนยันปิดเคส ${E.ticket_number}`);
  check("H8e a question from before the last status change no longer counts", r.sent[0]?.notification_type === "close_confirmation_request" && E.status === "REOPENED", `${types(r.sent)} E=${E.status}`);

  // -------------------------------------------------------------------------
  console.log("\nH9 — a cancelled case is never told 'closed over 7 days'");
  reset();
  const F = addTicket(6, "CANCELLED", "ขอย้อนสถานะเอกสาร", { closed_at: null });
  r = await customer(`ยังมีปัญหาอยู่ ${F.ticket_number} ค่ะ`);
  check("H9a says it was cancelled and offers a new case from it", r.sent[0]?.notification_type === "case_context" && (r.sent[0]?.quickReplies[0]?.text || "").startsWith("เปิดเคสใหม่: ติดตามต่อจาก"), `${types(r.sent)} ${JSON.stringify(r.sent[0]?.quickReplies)}`);
  check("H9b no reopen_too_old", !r.sent.some((n) => n.notification_type === "reopen_too_old"));

  // -------------------------------------------------------------------------
  console.log("\nH10 — typed re-open asks 'same or new?' unless the flow asked");
  reset();
  let G = addTicket(7, "CLOSED", "พิมพ์ใบเสร็จไม่ได้", { closed_at: new Date(Date.now() - 86_400_000) });
  r = await customer(`ยืนยันเปิดเคสอีกครั้ง ${G.ticket_number}`);
  check("H10a no question → asks same/new, not re-opened", r.sent[0]?.notification_type === "reopen_which_kind" && G.status === "CLOSED", `${types(r.sent)} G=${G.status}`);
  r = await customer(`ปัญหาเดิม ${G.ticket_number}`);
  check("H10b ...'ปัญหาเดิม' then re-opens", G.status === "REOPENED", `G is ${G.status}`);

  reset();
  G = addTicket(7, "CLOSED", "พิมพ์ใบเสร็จไม่ได้", { closed_at: new Date(Date.now() - 86_400_000) });
  aiSays(`ต้องการเปิดเคส ${G.ticket_number} เรื่อง "พิมพ์ใบเสร็จไม่ได้" อีกครั้งใช่ไหมคะ`);
  r = await customer(`ยืนยันเปิดเคสอีกครั้ง ${G.ticket_number}`);
  check("H10c the AI flow's own re-open question still re-opens at once", G.status === "REOPENED", `G is ${G.status}; ${types(r.sent)}`);

  // ISSUE-090: the [ยกเลิก] chip / "ไม่" under the AI re-open question is answered by the backend.
  for (const decline of ["ยกเลิก", "ไม่ค่ะ", "ไม่ต้องเปิดแล้วค่ะ"]) {
    reset();
    G = addTicket(7, "CLOSED", "พิมพ์ใบเสร็จไม่ได้", { closed_at: new Date(Date.now() - 86_400_000) });
    aiSays(`ต้องการเปิดเคส ${G.ticket_number} เรื่อง "พิมพ์ใบเสร็จไม่ได้" อีกครั้งใช่ไหมคะ`);
    r = await customer(decline);
    check(`H10d '${decline}' under the re-open question is acknowledged, case stays closed`, r.outcome?.reason === "REOPEN_CANCELLED" && r.sent[0]?.notification_type === "acknowledgement_action" && G.status === "CLOSED", `${r.outcome?.reason} ${types(r.sent)} G=${G.status}`);
  }

  // -------------------------------------------------------------------------
  console.log("\nDetectors and Fast Ack");
  check("D1 scope pending: 'ใช้งานได้แล้วค่ะ' is NONE", detectReopenScope("ใช้งานได้แล้วค่ะ", true) === "NONE");
  check("D2 scope pending: 'ขอคุยกับเจ้าหน้าที่' is NONE", detectReopenScope("ขอคุยกับเจ้าหน้าที่", true) === "NONE");
  check("D3 scope pending: symptom is SAME", detectReopenScope("ระดับการศึกษา ปวส. ยังไม่ขึ้นให้เลือกเลยค่ะ", true) === "SAME");
  check("D4 scope pending: 'ปัญหาใหม่' is NEW", detectReopenScope("ปัญหาใหม่ TCK-2026-10001", true) === "NEW");
  check("D5 bare short answers", isBareShortAnswer("ใช่ค่ะ") && isBareShortAnswer("โอเค") && !isBareShortAnswer("ปัญหาเดิม TCK-2026-10001"));
  check("D6 explicit declines", isExplicitDeclineClose("ยังไม่ปิดค่ะ") && isExplicitDeclineCancel("ไม่ยกเลิก") && !isExplicitDeclineClose("ไม่") && !isExplicitDeclineCancel("ยกเลิก"));
  check("D6b re-open declines (ISSUE-090)", ["ยกเลิก", "ไม่", "ไม่ครับ", "ไม่ต้องเปิดแล้วค่ะ", "ยังไม่เปิดเคส", "no"].every(isDeclineReopen) && !["ไม่หายเลยค่ะ", "ยกเลิกเคส TCK-2026-10001", "ยืนยันเปิดเคสอีกครั้ง"].some(isDeclineReopen));
  check("D7 Fast Ack: chip → choice", ["ยังไม่ปิด", "ไม่ยกเลิก", `ปัญหาเดิม TCK-2026-10001`, "ตรวจสอบสถานะ"].every((t) => CustomerNotificationService.classifyAcknowledgement(t) === "acknowledgement_choice"));
  check("D8 Fast Ack: other types unchanged", CustomerNotificationService.classifyAcknowledgement("ขอแก้ไขข้อมูล") === "acknowledgement_edit" && CustomerNotificationService.classifyAcknowledgement("ครับ") === "acknowledgement_action" && CustomerNotificationService.classifyAcknowledgement("ระบบเข้าไม่ได้ตั้งแต่เช้า ขึ้นหน้าขาว") === "acknowledgement" && CustomerNotificationService.classifyAcknowledgement("แก้ข้อมูลค่ะ", "edit") === "acknowledgement_edit");
  const choiceBodies = Array.from({ length: 40 }, (_, i) => (customerNotificationService as any).body("acknowledgement_choice", null, `seed-${i}`, null, null, null) as string);
  check("D9 choice receipts never promise 'แอดมินดู'", choiceBodies.every((b) => b && !/แอดมิน|ดูให้/.test(b)), choiceBodies.find((b) => /แอดมิน|ดูให้/.test(b)) || "");

  console.log(`\n${passes} ผ่าน, ${failures} พลาด`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
