/**
 * LINE stickers (2026-09-24). Runs the REAL CustomerNotificationService.send()
 * and CustomerStickerHandler against an in-memory fake of the rows they read
 * and write; axios is stubbed so every LINE payload is captured instead of
 * sent. No infrastructure needed:
 *
 *   npx tsx src/test-line-stickers.ts
 */

import axios from "axios";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { config } from "./config/env";
import { traceRecorder } from "./observability/TraceRecorder";
import { customerNotificationService } from "./services/CustomerNotificationService";
import { answerCustomerSticker } from "./services/CustomerStickerHandler";
import { STICKERS, classifyStickerMood } from "./services/LineStickers";

// ---------------------------------------------------------------------------
// In-memory world
// ---------------------------------------------------------------------------

const CONV = 515151;
interface Row { id: number; conversation_id: number; ticket_id: number | null; notification_type: string; status: string; created_at: Date }
interface Msg { conversation_id: number; role: string; content: string; message_type: string; created_at: Date }
let notifications: Row[] = [];
let messages: Msg[] = [];
let tickets: Array<{ id: number; ticket_number: string; status: string; subject: string }> = [];
let channel = "line";
let owner = { handled_by: "ai", takeover_state: "none" };
let pushes: Array<{ url: string; messages: any[] }> = [];
let seq = 1;

function reset() {
  notifications = [];
  messages = [];
  tickets = [{ id: 7001, ticket_number: "TCK-2026-10002", status: "RESOLVED", subject: "ใบเสร็จไม่ขึ้น" }];
  channel = "line";
  owner = { handled_by: "ai", takeover_state: "none" };
  pushes = [];
  (config as any).LINE_STICKERS_ENABLED = true;
}

/** A question / notice the bot already sent. */
function sent(type: string, ticketId: number | null = null) {
  notifications.push({ id: seq++, conversation_id: CONV, ticket_id: ticketId, notification_type: type, status: "sent", created_at: new Date() });
}

const aiOwned = () => owner.handled_by === "ai" && owner.takeover_state === "none";

const fakeQuery = async (sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> => {
  const s = String(sql);
  const out = (rows: any[]) => ({ rows, rowCount: rows.length });
  if (/JOIN identities/.test(s)) return out([{ channel_ref: "U-test", channel, project_id: 1, org_id: "org_test" }]);
  if (/INSERT INTO customer_notifications/.test(s)) {
    const row = { id: seq++, conversation_id: Number(params[0]), ticket_id: params[1] ?? null, notification_type: String(params[4]), status: "pending", created_at: new Date() };
    notifications.push(row);
    return out([{ id: row.id }]);
  }
  if (/UPDATE customer_notifications SET status = 'sent'/.test(s)) {
    const row = notifications.find((n) => n.id === Number(params[0]));
    if (row) row.status = "sent";
    return out([]);
  }
  if (/AS ai_owned,/.test(s)) {
    const since = Date.now() - Number(params[1]) * 60_000;
    const recent = messages.some((m) => m.role === "ai" && m.message_type === "sticker" && m.created_at.getTime() >= since);
    return out([{ ai_owned: aiOwned(), recent }]);
  }
  if (/AS ai_owned\s+FROM conversations/.test(s)) return out([{ ai_owned: aiOwned() }]);
  if (/INSERT INTO messages/.test(s)) {
    const type = /'sticker'/.test(s) ? "sticker" : "text";
    const role = /'customer'/.test(s) ? "customer" : "ai";
    messages.push({ conversation_id: Number(params[0]), role, content: String(params[1]), message_type: type, created_at: new Date() });
    return out([{ id: seq++ }]);
  }
  if (/FROM customer_notifications n/.test(s) && /<> ALL/.test(s)) {
    const passive: string[] = params[2];
    const row = notifications.filter((n) => n.conversation_id === Number(params[0]) && n.status === "sent" && !passive.includes(n.notification_type)).pop();
    if (!row) return out([]);
    const t = tickets.find((x) => x.id === row.ticket_id);
    return out([{ notification_type: row.notification_type, ticket_number: t?.ticket_number ?? null, status: t?.status ?? null, created_at: row.created_at }]);
  }
  if (/FROM messages/.test(s) && /role = 'ai'/.test(s) && /message_purpose/.test(s)) return out([]);
  if (/FROM tickets WHERE id = \$1/.test(s)) {
    const t = tickets.find((x) => x.id === Number(params[0]));
    return out(t ? [{ status: t.status, subject: t.subject, created_at: new Date(), due_date: null, resolved_at: new Date() }] : []);
  }
  return out([]);
};
(pool as any).query = fakeQuery;
(pool as any).connect = async () => {
  throw new Error("test-line-stickers must not connect to a real database");
};
(axios as any).post = async (url: string, body: any) => {
  pushes.push({ url, messages: body?.messages ?? [] });
  return { data: {} };
};
(traceRecorder as any).record = async () => {};

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
const shape = (m: any[]) => m.map((x) => (x.type === "sticker" ? `sticker:${x.stickerId}` : `text${x.quickReply ? "+chips" : ""}`)).join(" | ") || "(nothing)";
const last = () => pushes[pushes.length - 1]?.messages ?? [];

async function notify(type: any, extra: Record<string, unknown> = {}) {
  return customerNotificationService.send({ conversationId: CONV, notificationType: type, idempotencyKey: `k-${seq++}`, ...extra });
}

async function main() {
  if ((pool as any).query !== fakeQuery) {
    console.error("Refusing to run: the in-memory database fake is not installed.");
    process.exit(1);
  }

  console.log("\nบอทส่งสติกเกอร์ไปกับข้อความ");
  reset();
  await notify("closed", { ticketId: 7001, ticketNumber: "TCK-2026-10002", quickReplies: [] });
  check("S1 closed: THANK YOU sticker first, then the text", shape(last()) === `sticker:${STICKERS.thankYou.stickerId} | text`, shape(last()));
  check("S1b the sticker is written to messages", messages.some((m) => m.role === "ai" && m.message_type === "sticker" && m.content.includes("THANK YOU")));

  reset();
  await notify("resolution_confirmation", { ticketId: 7001, ticketNumber: "TCK-2026-10002" });
  check("S2 delivery card: sticker first, chips stay on the text (last bubble)", shape(last()) === `sticker:${STICKERS.howAboutIt.stickerId} | text+chips`, shape(last()));

  await notify("closed", { ticketId: 7001, ticketNumber: "TCK-2026-10002", quickReplies: [] });
  check("S3 a case event right after another still carries its sticker (quick 'ใช้งานได้แล้ว')", shape(last()) === `sticker:${STICKERS.thankYou.stickerId} | text`, shape(last()));

  reset();
  await notify("greeting");
  check("S3b greeting: Hello? sticker first", shape(last()) === `sticker:${STICKERS.hello.stickerId} | text`, shape(last()));
  await notify("greeting");
  await notify("thanks");
  check("S3c greeting / thanks again within 10 minutes: text only", pushes.slice(-2).every((p) => shape(p.messages) === "text"), pushes.slice(-2).map((p) => shape(p.messages)).join(" ; "));

  reset();
  owner = { handled_by: "human", takeover_state: "active" };
  await notify("closed", { ticketId: 7001, ticketNumber: "TCK-2026-10002", quickReplies: [] });
  check("S4 staff owns the chat: no sticker", shape(last()) === "text", shape(last()));

  reset();
  for (const t of ["cancelled", "action_failed", "auto_closed", "close_confirmation_request", "acknowledgement"]) {
    pushes = [];
    await notify(t, { ticketId: 7001, ticketNumber: "TCK-2026-10002" });
    check(`S5 '${t}' never carries a sticker`, !last().some((m: any) => m.type === "sticker"), shape(last()));
  }

  reset();
  (config as any).LINE_STICKERS_ENABLED = false;
  await notify("ticket_created", { ticketId: 7001, ticketNumber: "TCK-2026-10002" });
  check("S6 LINE_STICKERS_ENABLED=false: text only", shape(last()) === "text", shape(last()));

  reset();
  channel = "webchat";
  const wc = await notify("closed", { ticketId: 7001, ticketNumber: "TCK-2026-10002", quickReplies: [] });
  check("S7 WebChat: no LINE push at all", pushes.length === 0 && wc.sent === true, `${pushes.length} pushes`);

  console.log("\nลูกค้าส่งสติกเกอร์มา");
  reset();
  let r = await answerCustomerSticker({ conversationId: CONV, eventId: "ev-1", messageId: "m-1", keywords: ["Hello", "Hi"] });
  check("L1 hello sticker → the Hello? sticker back, nothing else", r.answer === "sticker" && shape(last()) === `sticker:${STICKERS.hello.stickerId}`, `${JSON.stringify(r)} ${shape(last())}`);
  check("L1b the customer's sticker is recorded", messages.some((m) => m.role === "customer" && m.message_type === "sticker" && m.content.includes("Hello")));

  reset();
  r = await answerCustomerSticker({ conversationId: CONV, eventId: "ev-2", keywords: ["angry", "grr"] });
  check("L2 angry sticker → SORRY sticker + one line inviting them to type", shape(last()) === `sticker:${STICKERS.sorryForTrouble.stickerId} | text`, shape(last()));

  reset();
  r = await answerCustomerSticker({ conversationId: CONV, eventId: "ev-3" });
  check("L3 no keywords → the cheerful Sally", shape(last()) === `sticker:${STICKERS.cheerful.stickerId}`, shape(last()));

  reset();
  r = await answerCustomerSticker({ conversationId: CONV, eventId: "ev-4", text: "ขอบคุณมากค่ะ" });
  check("L4 message sticker 'ขอบคุณมากค่ะ' → OF COURSE!", shape(last()) === `sticker:${STICKERS.ofCourse.stickerId}`, shape(last()));

  reset();
  messages.push({ conversation_id: CONV, role: "ai", content: "[สติกเกอร์: GOT IT!]", message_type: "sticker", created_at: new Date(Date.now() - 2 * 60_000) });
  r = await answerCustomerSticker({ conversationId: CONV, eventId: "ev-5", keywords: ["OK"] });
  check("L5 bot sent a sticker 2 minutes ago → silence (no empty push)", r.answer === "silent" && pushes.length === 0, `${JSON.stringify(r)} ${pushes.length}`);

  reset();
  owner = { handled_by: "human", takeover_state: "active" };
  r = await answerCustomerSticker({ conversationId: CONV, eventId: "ev-6", keywords: ["OK"] });
  check("L6 staff owns the chat → silence", r.answer === "silent" && pushes.length === 0, JSON.stringify(r));

  reset();
  (config as any).LINE_STICKERS_ENABLED = false;
  r = await answerCustomerSticker({ conversationId: CONV, eventId: "ev-7", keywords: ["OK"] });
  check("L7 disabled → silence, sticker still recorded", r.answer === "silent" && pushes.length === 0 && messages.some((m) => m.role === "customer"), JSON.stringify(r));

  console.log("\nลูกค้าส่งสติกเกอร์ ตอนบอทถามค้าง");
  reset();
  tickets[0].status = "CUSTOMER_CONFIRMED";
  sent("close_confirmation_request", 7001);
  r = await answerCustomerSticker({ conversationId: CONV, eventId: "ev-8", keywords: ["OK"] });
  const chips = last()[1]?.quickReply?.items?.map((i: any) => i.action.text) ?? [];
  check("M1 close question pending → PLEASE sticker + reminder with its chips", r.answer === "reminder" && shape(last()) === `sticker:${STICKERS.please.stickerId} | text+chips`, shape(last()));
  check("M1b chips are the close question's", chips.join("/") === "ยืนยันปิดเคส TCK-2026-10002/ยังไม่ปิด", chips.join("/"));
  check("M1c the sticker is never the answer: case not closed", tickets[0].status === "CUSTOMER_CONFIRMED");

  reset();
  sent("resolution_confirmation", 7001);
  r = await answerCustomerSticker({ conversationId: CONV, eventId: "ev-9", keywords: ["OK"] });
  const chips2 = last()[1]?.quickReply?.items?.map((i: any) => i.action.label) ?? [];
  check("M2 delivery card pending → reminder with ใช้งานได้แล้ว / ยังมีปัญหาอยู่", r.answer === "reminder" && chips2.join("/") === "ใช้งานได้แล้ว/ยังมีปัญหาอยู่", `${JSON.stringify(r)} ${chips2.join("/")}`);

  reset();
  sent("close_which_case", null);
  r = await answerCustomerSticker({ conversationId: CONV, eventId: "ev-10", keywords: ["OK"] });
  check("M3 'which case' list pending → silence (chips cannot be rebuilt)", r.answer === "silent" && pushes.length === 0, JSON.stringify(r));

  reset();
  messages.push({ conversation_id: CONV, role: "ai", content: "[สติกเกอร์: GOT IT!]", message_type: "sticker", created_at: new Date() });
  sent("cancel_confirmation_request", 7001);
  tickets[0].status = "IN_PROGRESS";
  r = await answerCustomerSticker({ conversationId: CONV, eventId: "ev-11", keywords: ["OK"] });
  check("M4 reminder inside the 10-minute window → text + chips, no sticker", shape(last()) === "text+chips", shape(last()));

  console.log("\nอ่านอารมณ์สติกเกอร์");
  const cases: Array<[unknown, unknown, string]> = [
    [["Hello"], "", "hello"], [["Good morning"], "", "hello"], [["Thanks"], "", "thanks"], [["Love"], "", "love"],
    [["Sad", "Crying"], "", "sad"], [["Angry"], "", "angry"], [["Good night"], "", "night"], [["OK"], "", "ok"],
    [["Sorry", "Angry"], "", "angry"], [[], "สวัสดีค่ะ", "hello"], [[], "ฝันดีนะ", "night"], [undefined, undefined, "other"], [["Dance"], "", "other"],
  ];
  for (const [k, t, want] of cases) {
    const got = classifyStickerMood(k, t);
    check(`C ${JSON.stringify(k ?? null)} ${t ? `"${t}"` : ""} → ${want}`, got === want, `got ${got}`);
  }

  console.log(`\n${passes} ผ่าน, ${failures} พลาด`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
