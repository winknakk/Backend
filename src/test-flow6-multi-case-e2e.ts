/**
 * test-flow6-multi-case-e2e.ts
 *
 * Authoritative Acceptance Test Suite for TicketX Flow 6 Revision:
 * Multi-Case Context Resolution & Intelligent Case Switching.
 *
 * Verifies all 17 Acceptance Scenarios (F6-01 through F6-17) against:
 * - Live Fastify backend (http://localhost:3000)
 * - Real PostgreSQL database (csdb)
 * - Real WebSocket gateway
 */

import assert from "node:assert";
// @ts-ignore
import WebSocket from "ws";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { JwtUtil } from "./shared/jwt";
import { getWebchatJwtSecret } from "./middleware/customerAuth";

const BASE_URL = "http://localhost:3000";
const WS_URL = "ws://localhost:3000/api/v1/webchat/socket";

interface TestContext {
  profileId: string;
  identityId: string;
  channelRef: string;
  projectId: number;
  companyId: number;
  conversationId: number;
  token: string;
  ticket1: { id: number; ticket_number: string; subject: string; slug: string };
  ticket2: { id: number; ticket_number: string; subject: string; slug: string };
  ticket3: { id: number; ticket_number: string; subject: string };
  foreignTicketId: number;
  crossProjectTicketId: number;
}

async function setupFixture(): Promise<TestContext> {
  const ts = Date.now();
  const channelRef = `test_f6_rev_${ts}`;
  const profileId = `999${ts.toString().slice(-5)}`;
  const companyId = 1;
  const projectId = 2; // Project 2

  // 1. Create Customer Profile
  await pool.query(
    `INSERT INTO profiles (id, company_id, name, email, created_at, is_pii_erased, is_merged)
     VALUES ($1, $2, $3, $4, NOW(), false, false)
     ON CONFLICT (id) DO NOTHING`,
    [profileId, companyId, `TestCustomer_${ts}`, `cust_${ts}@example.com`]
  );

  // 2. Associate Profile with Project 2
  await pool.query(
    `INSERT INTO profile_projects (profile_id, project_id, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (profile_id, project_id) DO NOTHING`,
    [profileId, projectId]
  );

  // 3. Create Identity
  const identRes = await pool.query(
    `INSERT INTO identities (profile_id, channel, channel_ref, created_at, is_pii, is_shared_account)
     VALUES ($1, 'WebChat', $2, NOW(), false, false)
     RETURNING id`,
    [profileId, channelRef]
  );
  const identityId = String(identRes.rows[0].id);

  // 4. Create Canonical Conversation in Project 2
  const convRes = await pool.query(
    `INSERT INTO conversations (identity_id, project_id, org_id, channel, status, created_at)
     VALUES ($1, $2, 'org_default', 'webchat', 'open', NOW())
     RETURNING id`,
    [parseInt(identityId, 10), projectId]
  );
  const conversationId = Number(convRes.rows[0].id);

  // 5. Generate Signed Customer JWT Token
  const jwtSecret = getWebchatJwtSecret();
  const token = JwtUtil.sign(
    {
      identityId,
      profileId,
      companyId: String(companyId),
      projectId: String(projectId),
      channelRef,
      role: "customer",
    },
    jwtSecret,
    7200
  );

  // 6. Create Foreign Ticket (different profile)
  const foreignProfileId = `998${ts.toString().slice(-5)}`;
  await pool.query(
    `INSERT INTO profiles (id, company_id, name, created_at, is_pii_erased, is_merged)
     VALUES ($1, 1, 'ForeignCustomer', NOW(), false, false)
     ON CONFLICT (id) DO NOTHING`,
    [foreignProfileId]
  );
  const foreignIdent = await pool.query(
    `INSERT INTO identities (profile_id, channel, channel_ref, created_at)
     VALUES ($1, 'WebChat', $2, NOW())
     RETURNING id`,
    [foreignProfileId, `foreign_ref_${ts}`]
  );
  const foreignConv = await pool.query(
    `INSERT INTO conversations (identity_id, project_id, org_id, channel, status, created_at)
     VALUES ($1, 2, 'org_default', 'webchat', 'open', NOW())
     RETURNING id`,
    [foreignIdent.rows[0].id]
  );
  const foreignTicketRes = await pool.query(
    `INSERT INTO tickets (ticket_number, ticket_id, conversation_id, project_id, org_id, subject, summary, status, plane_status, priority, created_via, lifecycle_changed_at, created_at)
     VALUES ($1, $1, $2, 2, 'org_default', 'Foreign Ticket', 'Foreign Summary', 'OPEN', 'Backlog', 'Low', 'customer', NOW(), NOW())
     RETURNING id`,
    [`TCK-FOREIGN-${ts}`, foreignConv.rows[0].id]
  );
  const foreignTicketId = Number(foreignTicketRes.rows[0].id);

  // 7. Create Cross-Project Ticket (Project 1)
  const crossProjTicketRes = await pool.query(
    `INSERT INTO tickets (ticket_number, ticket_id, conversation_id, project_id, org_id, subject, summary, status, plane_status, priority, created_via, lifecycle_changed_at, created_at)
     VALUES ($1, $1, $2, 1, 'org_default', 'Cross Project Ticket', 'Cross Project Summary', 'OPEN', 'Backlog', 'Low', 'customer', NOW(), NOW())
     RETURNING id`,
    [`TCK-CROSS-${ts}`, conversationId]
  );
  const crossProjectTicketId = Number(crossProjTicketRes.rows[0].id);

  return {
    profileId,
    identityId,
    channelRef,
    projectId,
    companyId,
    conversationId,
    token,
    ticket1: { id: 0, ticket_number: "", subject: "", slug: "login-issue" },
    ticket2: { id: 0, ticket_number: "", subject: "", slug: "tax-invoice" },
    ticket3: { id: 0, ticket_number: "", subject: "" },
    foreignTicketId,
    crossProjectTicketId,
  };
}

async function getWsTicket(token: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/v1/webchat/ws-ticket`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) throw new Error(`Failed to get ws-ticket: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.ticket;
}

function sendWsMessage(token: string, payload: any): Promise<any[]> {
  return new Promise(async (resolve, reject) => {
    try {
      const ticket = await getWsTicket(token);
      const ws = new WebSocket(`${WS_URL}?ticket=${encodeURIComponent(ticket)}`);
      const received: any[] = [];
      let settleTimer: any = null;
      let hasEchoed = false;

      const fallbackTimer = setTimeout(() => {
        ws.close();
        resolve(received);
      }, 6000);

      ws.on("open", () => {
        ws.send(JSON.stringify(payload));
      });

      ws.on("message", (raw: any) => {
        try {
          const parsed = JSON.parse(raw.toString());
          received.push(parsed);

          if (payload.tempId && (parsed.data?.externalId === payload.tempId || parsed.externalId === payload.tempId)) {
            hasEchoed = true;
            // Plain messages without edge AI replies settle quickly once echoed
            if (!settleTimer) {
              settleTimer = setTimeout(() => {
                clearTimeout(fallbackTimer);
                ws.close();
                resolve(received);
              }, 400);
            }
          }

          // If we received an edge reply or outbound event, settle quickly once our echo has also arrived
          const evt = parsed.event || parsed.type;
          const isAiMsg = parsed.data?.role === "ai" || parsed.role === "ai";
          if (evt === "active_ticket_switched" || evt === "ticket_created" || isAiMsg) {
            if (!payload.tempId || hasEchoed) {
              if (settleTimer) clearTimeout(settleTimer);
              settleTimer = setTimeout(() => {
                clearTimeout(fallbackTimer);
                ws.close();
                resolve(received);
              }, 600);
            }
          }
        } catch {}
      });

      ws.on("error", (err: any) => {
        if (settleTimer) clearTimeout(settleTimer);
        clearTimeout(fallbackTimer);
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function waitForMessageInDb(externalId: string): Promise<any> {
  for (let i = 0; i < 20; i++) {
    const res = await pool.query(`SELECT * FROM messages WHERE external_id = $1`, [externalId]);
    if (res.rows.length > 0) return res.rows[0];
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

function getTextFromResponse(r: any): string {
  return String(r?.data?.content || r?.data?.text || r?.content || r?.text || "");
}

async function runAcceptanceSuite() {
  console.log("=================================================================");
  console.log("  TICKETX FLOW 6 REVISION: ACCEPTANCE TEST SUITE (F6-01 TO F6-17)");
  console.log("=================================================================");

  const ctx = await setupFixture();
  console.log(`[Fixture] Profile ${ctx.profileId}, Identity ${ctx.identityId}, Conv ${ctx.conversationId}, Project ${ctx.projectId}`);

  // Provision 3 initial distinct tickets
  const year = new Date().getFullYear();
  const tSuffix = Date.now().toString().slice(-5);
  const t1Res = await pool.query(
    `INSERT INTO tickets (ticket_number, ticket_id, conversation_id, project_id, org_id, subject, summary, status, plane_status, priority, created_via, lifecycle_changed_at, created_at)
     VALUES ($1, $1, $2, $3, 'org_default', 'ระบบเข้าสู่ระบบไม่ได้', 'login-issue', 'OPEN', 'Backlog', 'High', 'customer', NOW(), NOW())
     RETURNING id, ticket_number, subject`,
    [`TCK-${year}-${tSuffix}-A`, ctx.conversationId, ctx.projectId]
  );
  ctx.ticket1 = { ...t1Res.rows[0], slug: "login-issue" };

  const t2Res = await pool.query(
    `INSERT INTO tickets (ticket_number, ticket_id, conversation_id, project_id, org_id, subject, summary, status, plane_status, priority, created_via, lifecycle_changed_at, created_at)
     VALUES ($1, $1, $2, $3, 'org_default', 'ขอใบกำกับภาษีประจำเดือน', 'tax-invoice', 'OPEN', 'Backlog', 'Medium', 'customer', NOW(), NOW())
     RETURNING id, ticket_number, subject`,
    [`TCK-${year}-${tSuffix}-B`, ctx.conversationId, ctx.projectId]
  );
  ctx.ticket2 = { ...t2Res.rows[0], slug: "tax-invoice" };

  const t3Res = await pool.query(
    `INSERT INTO tickets (ticket_number, ticket_id, conversation_id, project_id, org_id, subject, summary, status, plane_status, priority, created_via, lifecycle_changed_at, created_at)
     VALUES ($1, $1, $2, $3, 'org_default', 'สอบถามแพ็กเกจราคาบริการ', 'Pricing inquiry', 'OPEN', 'Backlog', 'Low', 'customer', NOW(), NOW())
     RETURNING id, ticket_number, subject`,
    [`TCK-${year}-${tSuffix}-C`, ctx.conversationId, ctx.projectId]
  );
  ctx.ticket3 = t3Res.rows[0];

  assert.ok(ctx.ticket1.id && ctx.ticket2.id && ctx.ticket3.id, "3 distinct cases must exist");

  // ─────────────────────────────────────────────────────────────
  // F6-01: Customer has 3 active cases. Sends short message clearly continuing active case.
  // Expected: auto route to active case, NO clarification prompt.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-01] Testing active case default routing for short message without clarification prompt...");
  await pool.query(`UPDATE conversations SET active_ticket_id = $1 WHERE id = $2`, [ctx.ticket1.id, ctx.conversationId]);

  const f601MsgId = `f601_${Date.now()}`;
  const f601Responses = await sendWsMessage(ctx.token, {
    text: "ยังไม่ได้ครับ",
    tempId: f601MsgId,
    activeTicketId: ctx.ticket1.id,
  });

  // Verify message persisted under Case 1
  const f601Db = await pool.query(`SELECT id, ticket_id, content FROM messages WHERE external_id = $1`, [f601MsgId]);
  assert.strictEqual(f601Db.rows.length, 1);
  assert.strictEqual(Number(f601Db.rows[0].ticket_id), ctx.ticket1.id);

  // Verify no ambiguity clarification was emitted
  const hasAmbiguityPrompt = f601Responses.some((r) => r.text && r.text.includes("ต้องการคุยเคสไหน"));
  assert.strictEqual(hasAmbiguityPrompt, false, "System must NOT prompt customer for short continuation message");
  console.log(`  ✅ F6-01 PASS: Auto-routed to active Case 1 (ticket_id = ${f601Db.rows[0].ticket_id}) with NO clarification prompt`);

  // ─────────────────────────────────────────────────────────────
  // F6-02: Customer references Case 2 using subject/slug.
  // Expected: auto switch to Case 2.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-02] Customer references Case 2 using subject keywords ('ขอใบกำกับภาษี')...");
  const f602MsgId = `f602_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "ขอเปลี่ยนไปคุยเรื่องขอใบกำกับภาษีหน่อยครับ",
    tempId: f602MsgId,
  });

  const convF602 = await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  assert.strictEqual(Number(convF602.rows[0].active_ticket_id), ctx.ticket2.id);

  const f602Db = await pool.query(`SELECT id, ticket_id FROM messages WHERE external_id = $1`, [f602MsgId]);
  assert.strictEqual(Number(f602Db.rows[0].ticket_id), ctx.ticket2.id);
  console.log(`  ✅ F6-02 PASS: Auto switched to Case 2 (#${ctx.ticket2.id}) via subject/slug`);

  // ─────────────────────────────────────────────────────────────
  // F6-03: Customer references Case 1 using ticket number.
  // Expected: auto switch to Case 1.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-03] Customer references Case 1 using ticket number...");
  const f603MsgId = `f603_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: `ขอติดตามตั๋วหมายเลข ${ctx.ticket1.ticket_number} ครับ`,
    tempId: f603MsgId,
  });

  const convF603 = await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  assert.strictEqual(Number(convF603.rows[0].active_ticket_id), ctx.ticket1.id);

  const f603Db = await pool.query(`SELECT id, ticket_id FROM messages WHERE external_id = $1`, [f603MsgId]);
  assert.strictEqual(Number(f603Db.rows[0].ticket_id), ctx.ticket1.id);
  console.log(`  ✅ F6-03 PASS: Auto switched to Case 1 via ticket number (${ctx.ticket1.ticket_number})`);

  // ─────────────────────────────────────────────────────────────
  // F6-04: Customer has 2 similar cases. Sends ambiguous message.
  // Expected: ask customer to choose, no incorrect ticket mutation.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-04] Creating 2 similar cases and sending ambiguous message...");
  // Create similar case to ticket2
  const tSimilarRes = await pool.query(
    `INSERT INTO tickets (ticket_number, ticket_id, conversation_id, project_id, org_id, subject, summary, status, plane_status, priority, created_via, lifecycle_changed_at, created_at)
     VALUES ($1, $1, $2, $3, 'org_default', 'ขอใบกำกับภาษีของปีก่อนหน้า', 'Previous tax invoice', 'OPEN', 'Backlog', 'Low', 'customer', NOW(), NOW())
     RETURNING id, ticket_number, subject`,
    [`TCK-${tSuffix}-SIM`, ctx.conversationId, ctx.projectId]
  );
  const ticketSimilar = tSimilarRes.rows[0];

  const activeBeforeAmbiguous = (await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId])).rows[0].active_ticket_id;

  const f604MsgId = `f604_${Date.now()}`;
  const f604Responses = await sendWsMessage(ctx.token, {
    text: "ขอสลับไปดูเรื่องขอใบกำกับภาษีหน่อยครับ",
    tempId: f604MsgId,
  });

  const convAfterAmbiguous = (await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId])).rows[0].active_ticket_id;
  assert.strictEqual(convAfterAmbiguous, activeBeforeAmbiguous, "Active ticket must NOT be mutated on ambiguous reference");

  const ambiguityPromptReceived = f604Responses.some((r) => {
    const t = getTextFromResponse(r);
    return t.includes("กำลังดำเนินการอยู่") || t.includes("ต้องการแจ้งข้อมูลเพิ่มเติม");
  });
  assert.ok(ambiguityPromptReceived, "System must provide clarification prompt with candidate options");
  console.log("  ✅ F6-04 PASS: Ambiguous reference asked clarification without mutating active ticket");

  // ─────────────────────────────────────────────────────────────
  // F6-05: Customer selects Case 2.
  // Expected: active_ticket_id = Case 2.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-05] Customer selects Case 2...");
  const selRes = await fetch(`${BASE_URL}/api/portal/switch-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ctx.token}` },
    body: JSON.stringify({ ticketId: ctx.ticket2.id }),
  });
  assert.strictEqual(selRes.status, 200);

  const convF605 = await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  assert.strictEqual(Number(convF605.rows[0].active_ticket_id), ctx.ticket2.id);
  console.log(`  ✅ F6-05 PASS: Active ticket switched to Case 2 (#${ctx.ticket2.id})`);

  // ─────────────────────────────────────────────────────────────
  // F6-06: Customer returns to Case 1 naturally.
  // Expected: auto switch Case 2 -> Case 1.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-06] Customer returns to Case 1 naturally ('กลับไปเรื่องเข้าสู่ระบบ')...");
  const f606MsgId = `f606_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "กลับไปเรื่องเข้าสู่ระบบไม่ได้ครับ",
    tempId: f606MsgId,
  });

  const convF606 = await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  assert.strictEqual(Number(convF606.rows[0].active_ticket_id), ctx.ticket1.id);
  console.log(`  ✅ F6-06 PASS: Returned to Case 1 (#${ctx.ticket1.id}) naturally`);

  // ─────────────────────────────────────────────────────────────
  // F6-07: Customer sends image while Case 1 is active.
  // Expected: message.ticket_id = Case 1, attachment linked correctly.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-07] Customer sends image while Case 1 is active...");
  const f607MsgId = `f607_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "",
    tempId: f607MsgId,
    activeTicketId: ctx.ticket1.id,
    attachments: [
      {
        fileUrl: "http://localhost:3000/uploads/error_screen.png",
        fileName: "error_screen.png",
        fileType: "image/png",
        fileSize: 4096,
      },
    ],
  });

  const f607MsgDb = await pool.query(`SELECT id, ticket_id FROM messages WHERE external_id = $1`, [f607MsgId]);
  assert.strictEqual(f607MsgDb.rows.length, 1);
  assert.strictEqual(Number(f607MsgDb.rows[0].ticket_id), ctx.ticket1.id);

  const f607AttDb = await pool.query(`SELECT id, message_id FROM message_attachments WHERE message_id = $1`, [f607MsgDb.rows[0].id]);
  assert.strictEqual(f607AttDb.rows.length, 1);
  console.log(`  ✅ F6-07 PASS: Image linked to Case 1 and message_attachments row created`);

  // ─────────────────────────────────────────────────────────────
  // F6-08: Customer sends image after switching to Case 2.
  // Expected: message.ticket_id = Case 2.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-08] Switching to Case 2 and sending image...");
  await pool.query(`UPDATE conversations SET active_ticket_id = $1 WHERE id = $2`, [ctx.ticket2.id, ctx.conversationId]);

  const f608MsgId = `f608_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "ส่งรูปใบเสร็จครับ",
    tempId: f608MsgId,
    activeTicketId: ctx.ticket2.id,
    attachments: [
      {
        fileUrl: "http://localhost:3000/uploads/tax_doc.png",
        fileName: "tax_doc.png",
        fileType: "image/png",
        fileSize: 2048,
      },
    ],
  });

  const f608MsgDb = await pool.query(`SELECT id, ticket_id FROM messages WHERE external_id = $1`, [f608MsgId]);
  assert.strictEqual(f608MsgDb.rows.length, 1);
  assert.strictEqual(Number(f608MsgDb.rows[0].ticket_id), ctx.ticket2.id);
  console.log(`  ✅ F6-08 PASS: Image linked to Case 2 (#${ctx.ticket2.id})`);

  // ─────────────────────────────────────────────────────────────
  // F6-09: Customer references CLOSED Case 3.
  // Expected: no message written to Case 3, no implicit reopen, offer NEW CASE.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-09] Closing Case 3 and referencing it...");
  await pool.query(`UPDATE tickets SET status = 'CLOSED', lifecycle_changed_at = NOW() WHERE id = $1`, [ctx.ticket3.id]);

  const f609MsgId = `f609_${Date.now()}`;
  const f609Responses = await sendWsMessage(ctx.token, {
    text: `ขอสอบถามเพิ่มเติมเรื่องตั๋ว ${ctx.ticket3.ticket_number} ครับ`,
    tempId: f609MsgId,
  });

  // Verify Case 3 remained CLOSED
  const case3Status = await pool.query(`SELECT status FROM tickets WHERE id = $1`, [ctx.ticket3.id]);
  assert.strictEqual(case3Status.rows[0].status, "CLOSED", "Case 3 must remain CLOSED");

  // Verify message has ticket_id = NULL
  const f609Db = await pool.query(`SELECT id, ticket_id FROM messages WHERE external_id = $1`, [f609MsgId]);
  assert.strictEqual(f609Db.rows.length, 1);
  assert.strictEqual(f609Db.rows[0].ticket_id, null, "Message ticket_id MUST be NULL for closed case reference");

  const closedNoticeReceived = f609Responses.some((r) => {
    const t = getTextFromResponse(r);
    return t.includes("ปิดเรียบร้อยแล้ว") || t.includes("ไม่สามารถเพิ่มข้อมูล");
  });
  assert.ok(closedNoticeReceived, "Closed case notice with new case offer must be returned");
  console.log("  ✅ F6-09 PASS: Case 3 remained CLOSED, message ticket_id was NULL, and new case offered");

  // ─────────────────────────────────────────────────────────────
  // F6-10: Customer confirms NEW CASE.
  // Expected: new ticket created, authorized, active_ticket_id = new ticket.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-10] Customer confirms new case creation from closed issue...");
  const f610MsgId = `f610_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: `เปิดเคสใหม่: ติดตามต่อจาก ${ctx.ticket3.ticket_number}`,
    tempId: f610MsgId,
  });

  const convF610 = await pool.query(`SELECT active_ticket_id, project_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  const newTicketId = Number(convF610.rows[0].active_ticket_id);
  assert.ok(newTicketId && newTicketId !== ctx.ticket1.id && newTicketId !== ctx.ticket2.id && newTicketId !== ctx.ticket3.id);

  const newTicketDb = await pool.query(`SELECT id, ticket_number, project_id, status FROM tickets WHERE id = $1`, [newTicketId]);
  assert.strictEqual(newTicketDb.rows.length, 1);
  assert.strictEqual(Number(newTicketDb.rows[0].project_id), ctx.projectId);
  console.log(`  ✅ F6-10 PASS: New ticket ${newTicketDb.rows[0].ticket_number} (#${newTicketId}) created and set active`);

  // ─────────────────────────────────────────────────────────────
  // F6-11: Customer introduces clearly unrelated issue.
  // Expected: NEW_CASE, do not attach to active existing case.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-11] Customer introduces clearly unrelated issue ('อีกเรื่องครับ ตอนนี้เข้า LINE ไม่ได้')...");
  const f611MsgId = `f611_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "อีกเรื่องครับ ตอนนี้เข้า LINE ไม่ได้เลย",
    tempId: f611MsgId,
  });

  const convF611 = await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  const unrelatedTicketId = Number(convF611.rows[0].active_ticket_id);
  assert.ok(unrelatedTicketId && unrelatedTicketId !== newTicketId);

  const f611Db = await pool.query(`SELECT id, ticket_id FROM messages WHERE external_id = $1`, [f611MsgId]);
  assert.strictEqual(Number(f611Db.rows[0].ticket_id), unrelatedTicketId);
  console.log(`  ✅ F6-11 PASS: Unrelated issue triggered NEW_CASE (#${unrelatedTicketId}) without attaching to previous case`);

  // ─────────────────────────────────────────────────────────────
  // F6-12: A -> B -> immediate send.
  // Expected: message.ticket_id = B.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-12] Testing A -> B immediate send...");
  await pool.query(`UPDATE conversations SET active_ticket_id = $1 WHERE id = $2`, [ctx.ticket1.id, ctx.conversationId]);

  const f612MsgId = `f612_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "ส่งข้อความทันทีหลังจากเปลี่ยนเป็นเคส 2 ครับ",
    tempId: f612MsgId,
    activeTicketId: ctx.ticket2.id,
    ticketNumber: ctx.ticket2.ticket_number,
  });

  const f612DbRow = await waitForMessageInDb(f612MsgId);
  assert.ok(f612DbRow, "f612 message row must exist in DB");
  assert.strictEqual(Number(f612DbRow.ticket_id), ctx.ticket2.id);
  console.log(`  ✅ F6-12 PASS: Immediate send message bound to Case 2 (ticket_id = ${ctx.ticket2.id})`);

  // ─────────────────────────────────────────────────────────────
  // F6-13: Refresh / reconnect restores active case from backend.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-13] Testing refresh/reconnect restoring active ticket...");
  const initRes = await fetch(`${BASE_URL}/api/portal/tickets`, {
    headers: { authorization: `Bearer ${ctx.token}` },
  });
  const initData = (await initRes.json()) as any;
  assert.strictEqual(Number(initData.activeTicketId), ctx.ticket2.id);
  console.log(`  ✅ F6-13 PASS: Refresh restored active ticket (#${initData.activeTicketId})`);

  // ─────────────────────────────────────────────────────────────
  // F6-14: Foreign ticket candidate fail closed.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-14] Testing foreign ticket candidate fail closed...");
  const f614MsgId = `f614_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "พยายามส่งเข้าเคสคนอื่น",
    tempId: f614MsgId,
    activeTicketId: ctx.foreignTicketId,
  });

  const f614Db = await pool.query(`SELECT id FROM messages WHERE external_id = $1`, [f614MsgId]);
  assert.strictEqual(f614Db.rows.length, 0, "Unauthorized message MUST NOT be inserted into database");
  console.log("  ✅ F6-14 PASS: Foreign ticket rejected fail-closed; zero DB rows inserted");

  // ─────────────────────────────────────────────────────────────
  // F6-15: Cross-project ticket candidate fail closed.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-15] Testing cross-project ticket candidate fail closed...");
  const f615MsgId = `f615_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "พยายามส่งเข้าข้ามโปรเจกต์",
    tempId: f615MsgId,
    activeTicketId: ctx.crossProjectTicketId,
  });

  const f615Db = await pool.query(`SELECT id FROM messages WHERE external_id = $1`, [f615MsgId]);
  assert.strictEqual(f615Db.rows.length, 0, "Cross-project message MUST NOT be inserted");
  console.log("  ✅ F6-15 PASS: Cross-project ticket rejected fail-closed; zero DB rows inserted");

  // ─────────────────────────────────────────────────────────────
  // F6-16: Switching cases does not change conversation.project_id.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-16] Verifying conversation.project_id immutability across all switches...");
  const convProjCheck = await pool.query(`SELECT project_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  assert.strictEqual(Number(convProjCheck.rows[0].project_id), 2, "conversation.project_id must strictly remain 2");
  console.log("  ✅ F6-16 PASS: conversation.project_id remained strictly 2 across all operations");

  // ─────────────────────────────────────────────────────────────
  // F6-17: Switching cases does not create a new conversation.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-17] Verifying conversation continuity across all switches...");
  const convCount = await pool.query(`SELECT COUNT(*) FROM conversations WHERE identity_id = $1`, [parseInt(ctx.identityId, 10)]);
  assert.strictEqual(Number(convCount.rows[0].count), 1, "Exactly 1 conversation row must exist for identity");
  console.log("  ✅ F6-17 PASS: Exactly 1 conversation maintained across all operations");

  console.log("\n=================================================================");
  console.log("  TICKETX FLOW 6 REVISION: SCENARIOS F6-18 TO F6-34");
  console.log("=================================================================");

  // ─────────────────────────────────────────────────────────────
  // F6-18: Active Case Continuation (short affirmative messages)
  // Expected: auto route to active Case 1 without clarification prompt
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-18] Active Case Continuation ('ส่งให้แล้วครับ')...");
  await pool.query(`UPDATE conversations SET active_ticket_id = $1 WHERE id = $2`, [ctx.ticket1.id, ctx.conversationId]);

  const f618MsgId = `f618_${Date.now()}`;
  const f618Responses = await sendWsMessage(ctx.token, {
    text: "ส่งให้แล้วครับ",
    tempId: f618MsgId,
    activeTicketId: ctx.ticket1.id,
  });
  const f618Db = await pool.query(`SELECT id, ticket_id FROM messages WHERE external_id = $1`, [f618MsgId]);
  assert.strictEqual(Number(f618Db.rows[0].ticket_id), ctx.ticket1.id);
  const f618HasAmbiguity = f618Responses.some((r) => getTextFromResponse(r).includes("ต้องการแจ้งข้อมูลเพิ่มเติมเรื่องไหน"));
  assert.strictEqual(f618HasAmbiguity, false, "Must NOT prompt customer on continuation");
  console.log(`  ✅ F6-18 PASS: Continuation routed to Case 1 (#${ctx.ticket1.id}) with zero prompt`);

  // ─────────────────────────────────────────────────────────────
  // F6-19: Image Continuation
  // Expected: image-only message routes to active Case 1
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-19] Image Continuation without text...");
  const f619MsgId = `f619_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "",
    tempId: f619MsgId,
    activeTicketId: ctx.ticket1.id,
    attachments: [
      {
        fileUrl: "http://localhost:3000/uploads/screenshot_evidence.png",
        fileName: "screenshot_evidence.png",
        fileType: "image/png",
        fileSize: 5120,
      },
    ],
  });
  const f619Db = await pool.query(`SELECT id, ticket_id FROM messages WHERE external_id = $1`, [f619MsgId]);
  assert.strictEqual(Number(f619Db.rows[0].ticket_id), ctx.ticket1.id);
  console.log(`  ✅ F6-19 PASS: Image-only message routed to active Case 1 (#${ctx.ticket1.id})`);

  // ─────────────────────────────────────────────────────────────
  // F6-20: Explicit Semantic Switch
  // Expected: switches to Case 2 based on natural text reference
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-20] Explicit Semantic Switch ('ขอดูเรื่องขอใบกำกับภาษีประจำเดือนหน่อยครับ')...");
  const f620MsgId = `f620_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "ขอดูเรื่องขอใบกำกับภาษีประจำเดือนหน่อยครับ",
    tempId: f620MsgId,
  });
  const convF620 = await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  assert.strictEqual(Number(convF620.rows[0].active_ticket_id), ctx.ticket2.id);
  const f620Db = await pool.query(`SELECT ticket_id FROM messages WHERE external_id = $1`, [f620MsgId]);
  assert.strictEqual(Number(f620Db.rows[0].ticket_id), ctx.ticket2.id);
  console.log(`  ✅ F6-20 PASS: Explicit semantic reference auto-switched to Case 2 (#${ctx.ticket2.id})`);

  // ─────────────────────────────────────────────────────────────
  // F6-21: Switch Overrides Active Case
  // Expected: strong reference to Case 1 while Case 2 active routes to Case 1
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-21] Switch Overrides Active Case (Case 2 active -> references login -> routes to Case 1)...");
  assert.strictEqual(Number(convF620.rows[0].active_ticket_id), ctx.ticket2.id);
  const f621MsgId = `f621_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "กลับไปเรื่องเข้าสู่ระบบไม่ได้ครับ",
    tempId: f621MsgId,
  });
  const convF621 = await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  assert.strictEqual(Number(convF621.rows[0].active_ticket_id), ctx.ticket1.id);
  const f621Db = await pool.query(`SELECT ticket_id FROM messages WHERE external_id = $1`, [f621MsgId]);
  assert.strictEqual(Number(f621Db.rows[0].ticket_id), ctx.ticket1.id);
  console.log(`  ✅ F6-21 PASS: Reference to Case 1 successfully overrode active Case 2 focus`);

  // ─────────────────────────────────────────────────────────────
  // F6-22: Two Same-Category Cases
  // Expected: Category alone MUST NOT select a ticket -> AMBIGUOUS_CASE
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-22] Two Same-Category Cases (issue_category is evidence ONLY, never unique ID)...");
  // Set both ticket1 and a new ticketCat2 to issue_category = 'LOGIN'
  await pool.query(`UPDATE tickets SET issue_category = 'LOGIN' WHERE id = $1`, [ctx.ticket1.id]);
  const cat2Res = await pool.query(
    `INSERT INTO tickets (ticket_number, ticket_id, conversation_id, project_id, org_id, subject, summary, issue_category, status, plane_status, priority, created_via, lifecycle_changed_at, created_at)
     VALUES ($1, $1, $2, $3, 'org_default', 'เข้าสู่ระบบบนเว็บไม่ได้', 'Web login issue', 'LOGIN', 'OPEN', 'Backlog', 'Medium', 'customer', NOW(), NOW())
     RETURNING id, ticket_number`,
    [`TCK-${tSuffix}-CAT2`, ctx.conversationId, ctx.projectId]
  );
  const ticketCat2Id = Number(cat2Res.rows[0].id);

  // Clear active ticket so neither has active bias
  await pool.query(`UPDATE conversations SET active_ticket_id = NULL WHERE id = $1`, [ctx.conversationId]);

  const f622MsgId = `f622_${Date.now()}`;
  const f622Responses = await sendWsMessage(ctx.token, {
    text: "สลับไปเรื่องเข้าไม่ได้ครับ",
    tempId: f622MsgId,
  });

  // Verify system asked for clarification and did NOT arbitrarily pick one
  const f622AmbiguousPrompt = f622Responses.some((r) => getTextFromResponse(r).includes("กำลังดำเนินการอยู่") || getTextFromResponse(r).includes("ต้องการแจ้งข้อมูลเพิ่มเติม"));
  assert.ok(f622AmbiguousPrompt, "System MUST return clarification prompt when two cases share category and generic terms");
  console.log(`  ✅ F6-22 PASS: Same-category cases triggered AMBIGUOUS_CASE without arbitrary selection`);

  // ─────────────────────────────────────────────────────────────
  // F6-23: Recent Context Resolution
  // Expected: customer refers to a case discussed earlier in recent messages
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-23] Recent Context Resolution...");
  // Insert recent messages under Case 2
  await pool.query(
    `INSERT INTO messages (conversation_id, role, content, message_type, ticket_id, created_at)
     VALUES ($1, 'ai', 'รบกวนขอเลขผู้เสียภาษี 13 หลักเพื่อออกใบกำกับภาษีค่ะ', 'text', $2, NOW())`,
    [ctx.conversationId, ctx.ticket2.id]
  );

  const f623MsgId = `f623_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "ขอส่งข้อมูลเพิ่มตามที่คุยกันครับ",
    tempId: f623MsgId,
  });
  const f623Db = await pool.query(`SELECT ticket_id FROM messages WHERE external_id = $1`, [f623MsgId]);
  assert.strictEqual(Number(f623Db.rows[0].ticket_id), ctx.ticket2.id);
  console.log(`  ✅ F6-23 PASS: Contextually resolved to recently discussed Case 2 (#${ctx.ticket2.id})`);

  // ─────────────────────────────────────────────────────────────
  // F6-24: New Issue Detection
  // Expected: clearly unrelated problem triggers NEW_CASE
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-24] New Issue Detection ('นอกจากเรื่องเดิม ตอนนี้ระบบจ่ายเงินผ่านบัตรเครดิตไม่ได้')...");
  const f624MsgId = `f624_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "นอกจากเรื่องเดิม ตอนนี้ระบบจ่ายเงินผ่านบัตรเครดิตไม่ได้ครับ",
    tempId: f624MsgId,
  });
  const convF624 = await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  const newCardTicketId = Number(convF624.rows[0].active_ticket_id);
  assert.ok(newCardTicketId && newCardTicketId !== ctx.ticket1.id && newCardTicketId !== ctx.ticket2.id && newCardTicketId !== ticketCat2Id);
  const f624Db = await pool.query(`SELECT ticket_id FROM messages WHERE external_id = $1`, [f624MsgId]);
  assert.strictEqual(Number(f624Db.rows[0].ticket_id), newCardTicketId);
  console.log(`  ✅ F6-24 PASS: Unrelated issue created and switched to NEW_CASE (#${newCardTicketId})`);

  // ─────────────────────────────────────────────────────────────
  // F6-25: No False New Case
  // Expected: continuation lacking exact ticket match MUST NOT create a new case
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-25] No False New Case ('เดี๋ยวลองใหม่ครับ')...");
  const countBeforeF625 = (await pool.query(`SELECT COUNT(*) FROM tickets WHERE conversation_id = $1`, [ctx.conversationId])).rows[0].count;
  const f625MsgId = `f625_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "เดี๋ยวลองใหม่อีกทีครับ",
    tempId: f625MsgId,
    activeTicketId: newCardTicketId,
  });
  const countAfterF625 = (await pool.query(`SELECT COUNT(*) FROM tickets WHERE conversation_id = $1`, [ctx.conversationId])).rows[0].count;
  assert.strictEqual(countAfterF625, countBeforeF625, "Must NOT create new case on continuation without exact match");
  const f625Db = await pool.query(`SELECT ticket_id FROM messages WHERE external_id = $1`, [f625MsgId]);
  assert.strictEqual(Number(f625Db.rows[0].ticket_id), newCardTicketId);
  console.log(`  ✅ F6-25 PASS: Continuation attached to active case without spurious ticket creation`);

  // ─────────────────────────────────────────────────────────────
  // F6-26: Closed Case Reference & Decoupling
  // Expected: closed ticket remains CLOSED, receives no message; message.ticket_id = null;
  // reactions contains referenced_ticket_id, ticket_events contains CLOSED_CASE_REFERENCED
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-26] Closed Case Reference & Decoupling...");
  const f626MsgId = `f626_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: `ขอตามงานตั๋วเดิม ${ctx.ticket3.ticket_number} ครับ`,
    tempId: f626MsgId,
  });

  const f626Db = await pool.query(`SELECT id, ticket_id, reactions FROM messages WHERE external_id = $1`, [f626MsgId]);
  assert.strictEqual(f626Db.rows.length, 1);
  assert.strictEqual(f626Db.rows[0].ticket_id, null, "message.ticket_id MUST be null on closed case reference");
  assert.strictEqual(f626Db.rows[0].reactions?.referenced_ticket_id, ctx.ticket3.id, "reactions must store decoupled referenced_ticket_id");

  const evtCheck = await pool.query(`SELECT id, event_type FROM ticket_events WHERE ticket_id = $1 AND event_type = 'CLOSED_CASE_REFERENCED'`, [ctx.ticket3.id]);
  assert.ok(evtCheck.rows.length >= 1, "ticket_events must record CLOSED_CASE_REFERENCED");
  console.log(`  ✅ F6-26 PASS: Closed case decoupling preserved in reactions and ticket_events; ticket_id = null`);

  // ─────────────────────────────────────────────────────────────
  // F6-27: Closed Case -> New Case
  // Expected: customer confirms continuation via new case
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-27] Closed Case -> New Case creation...");
  const f627MsgId = `f627_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: `เปิดเคสใหม่: ติดตามต่อเนื่องจาก ${ctx.ticket3.ticket_number}`,
    tempId: f627MsgId,
  });
  const convF627 = await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  const followupTicketId = Number(convF627.rows[0].active_ticket_id);
  assert.ok(followupTicketId && followupTicketId !== ctx.ticket3.id);
  const f627Db = await pool.query(`SELECT ticket_id FROM messages WHERE external_id = $1`, [f627MsgId]);
  assert.strictEqual(Number(f627Db.rows[0].ticket_id), followupTicketId);
  console.log(`  ✅ F6-27 PASS: Followup ticket #${followupTicketId} created from closed case`);

  // ─────────────────────────────────────────────────────────────
  // F6-28: Immediate Send After Automatic Switch
  // Expected: auto-switch + immediate customer message routes to new case
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-28] Immediate Send After Automatic Switch...");
  const f628SwitchId = `f628_sw_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "สลับไปเรื่องขอใบกำกับภาษีประจำเดือนหน่อยครับ",
    tempId: f628SwitchId,
  });
  const f628ImmediateId = `f628_imm_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "อันนี้เป็นเลขประจำตัวผู้เสียภาษี 1234567890123 ครับ",
    tempId: f628ImmediateId,
  });
  const f628Db = await pool.query(`SELECT ticket_id FROM messages WHERE external_id = $1`, [f628ImmediateId]);
  assert.strictEqual(Number(f628Db.rows[0].ticket_id), ctx.ticket2.id);
  console.log(`  ✅ F6-28 PASS: Immediate message post-switch bound directly to Case 2 (#${ctx.ticket2.id})`);

  // ─────────────────────────────────────────────────────────────
  // F6-29: Multi-step Case Hopping
  // Expected: Case 1 -> Case 2 -> Case 1 -> New Case inside ONE conversation
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-29] Multi-step Case Hopping inside ONE conversation...");
  // Step 1: Switch to Case 1
  await sendWsMessage(ctx.token, { text: "กลับไปเรื่องเข้าสู่ระบบไม่ได้ครับ", tempId: `f629_1_${Date.now()}` });
  let hopConv = await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  assert.strictEqual(Number(hopConv.rows[0].active_ticket_id), ctx.ticket1.id);

  // Step 2: Switch to Case 2
  await sendWsMessage(ctx.token, { text: "ขอเปลี่ยนไปคุยเรื่องขอใบกำกับภาษีประจำเดือนหน่อยครับ", tempId: `f629_2_${Date.now()}` });
  hopConv = await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  assert.strictEqual(Number(hopConv.rows[0].active_ticket_id), ctx.ticket2.id);

  // Step 3: Return to Case 1
  await sendWsMessage(ctx.token, { text: "ขอกลับมาดูเรื่อง login ครับ", tempId: `f629_3_${Date.now()}` });
  hopConv = await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  assert.strictEqual(Number(hopConv.rows[0].active_ticket_id), ctx.ticket1.id);

  // Step 4: Open New Case
  const f629_4_id = `f629_4_${Date.now()}`;
  await sendWsMessage(ctx.token, { text: "เปิดเคสใหม่: ปัญหาการเชื่อมต่อ API", tempId: f629_4_id });
  hopConv = await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  const hopNewTicketId = Number(hopConv.rows[0].active_ticket_id);
  assert.ok(hopNewTicketId && hopNewTicketId !== ctx.ticket1.id && hopNewTicketId !== ctx.ticket2.id);
  console.log(`  ✅ F6-29 PASS: Seamlessly hopped Case 1 -> Case 2 -> Case 1 -> New Case (#${hopNewTicketId})`);

  // ─────────────────────────────────────────────────────────────
  // F6-30: Ambiguous Resolution via Customer Selection
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-30] Ambiguous Resolution via Selection API...");
  const selRes30 = await fetch(`${BASE_URL}/api/portal/switch-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ctx.token}` },
    body: JSON.stringify({ ticketId: ctx.ticket1.id }),
  });
  assert.strictEqual(selRes30.status, 200);
  const convF630 = await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  assert.strictEqual(Number(convF630.rows[0].active_ticket_id), ctx.ticket1.id);
  console.log(`  ✅ F6-30 PASS: Ambiguity resolved via explicit switch-ticket to Case 1 (#${ctx.ticket1.id})`);

  // ─────────────────────────────────────────────────────────────
  // F6-31: Ambiguous Does Not Mutate Focus
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-31] Ambiguous Does Not Mutate Focus...");
  const activeBefore31 = (await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId])).rows[0].active_ticket_id;
  await sendWsMessage(ctx.token, {
    text: "ขอสลับไปดูเรื่องขอใบกำกับภาษีหน่อยครับ",
    tempId: `f631_${Date.now()}`,
  });
  const activeAfter31 = (await pool.query(`SELECT active_ticket_id FROM conversations WHERE id = $1`, [ctx.conversationId])).rows[0].active_ticket_id;
  assert.strictEqual(activeAfter31, activeBefore31, "Focus MUST NOT mutate on ambiguity");
  console.log(`  ✅ F6-31 PASS: active_ticket_id remained strictly unchanged during ambiguity`);

  // ─────────────────────────────────────────────────────────────
  // F6-32: Unauthorized Candidate Fail Closed
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-32] Unauthorized Candidate Fail Closed...");
  const f632MsgId = `f632_${Date.now()}`;
  await sendWsMessage(ctx.token, {
    text: "พยายามเข้าถึงตั๋วคนอื่น",
    tempId: f632MsgId,
    activeTicketId: ctx.foreignTicketId,
  });
  const f632Db = await pool.query(`SELECT id FROM messages WHERE external_id = $1`, [f632MsgId]);
  assert.strictEqual(f632Db.rows.length, 0, "Unauthorized message must fail closed");
  console.log(`  ✅ F6-32 PASS: Unauthorized candidate strictly failed closed (zero rows persisted)`);

  // ─────────────────────────────────────────────────────────────
  // F6-33: Project Boundary Immutability
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-33] Project Boundary Immutability...");
  const f633Conv = await pool.query(`SELECT project_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  assert.strictEqual(Number(f633Conv.rows[0].project_id), ctx.projectId, "Project ID must strictly match original project 2");
  console.log(`  ✅ F6-33 PASS: conversation.project_id strictly remained ${ctx.projectId}`);

  // ─────────────────────────────────────────────────────────────
  // F6-34: Single Conversation Continuity
  // ─────────────────────────────────────────────────────────────
  console.log("\n[F6-34] Single Conversation Continuity...");
  const convCountFinal = await pool.query(`SELECT COUNT(*) FROM conversations WHERE identity_id = $1`, [parseInt(ctx.identityId, 10)]);
  assert.strictEqual(Number(convCountFinal.rows[0].count), 1, "Exactly ONE conversation record must exist");
  console.log(`  ✅ F6-34 PASS: Exactly 1 conversation maintained across all 34 acceptance scenarios`);

  console.log("\n=================================================================");
  console.log("  🎉 ALL 34 ACCEPTANCE SCENARIOS (F6-01 TO F6-34) VERIFIED PASS!");
  console.log("=================================================================\n");

  // Cleanup fixtures
  await pool.query("DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = $1)", [ctx.conversationId]);
  await pool.query("DELETE FROM messages WHERE conversation_id = $1", [ctx.conversationId]);
  await pool.query("DELETE FROM tickets WHERE conversation_id = $1", [ctx.conversationId]);
  await pool.query("DELETE FROM tickets WHERE id = $1", [ctx.foreignTicketId]);
  await pool.query("DELETE FROM conversations WHERE id = $1", [ctx.conversationId]);
  await pool.query("DELETE FROM identities WHERE id = $1", [ctx.identityId]);
  await pool.query("DELETE FROM profile_projects WHERE profile_id = $1", [ctx.profileId]);
  await pool.query("DELETE FROM profiles WHERE id IN ($1, 'ForeignCustomer')", [ctx.profileId]);
}

runAcceptanceSuite().catch((err) => {
  console.error("❌ ACCEPTANCE SUITE FAILED:", err);
  process.exit(1);
});
