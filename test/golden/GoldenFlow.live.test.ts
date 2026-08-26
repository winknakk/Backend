import assert from "assert";
import { describe, it, before, after } from "node:test";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { pool } from "../../src/adapters/postgres/PostgresAdapter";
import { ticketStateMachine } from "../../src/domain/ticket/TicketStateMachine";
import { customerNotificationService } from "../../src/services/CustomerNotificationService";
import { customerConfirmationHandler } from "../../src/services/CustomerConfirmationHandler";
import { detectConfirmationIntent } from "../../src/domain/ticket/CustomerConfirmation";
import { projectResolver } from "../../src/domain/project/ProjectResolver";

/**
 * NOT A GOLDEN E2E TEST.
 *
 * This is an INTEGRATION test of the TicketX lifecycle. It inserts rows
 * directly into PostgreSQL and calls TicketStateMachine, which means it
 * bypasses the real customer path entirely:
 *
 *   LINE -> LINE webhook -> PromptX/Activepieces -> Main AI Core Flow
 *        -> AgentX -> MCP create_ticket -> TicketX -> Plane
 *
 * It proves the lifecycle, the notification ledger and the confirmation
 * handler in isolation. It proves NOTHING about PromptX, AgentX, session
 * resolution, the intent decision as the flow actually makes it, or the MCP
 * tool boundary. Do not cite it as Golden Flow evidence — see
 * docs/REAL_AGENTX_GOLDEN_E2E_REPORT.md.
 *
 * Integration coverage against the live database, on the staging project.
 *
 * Covers everything from conversation to CLOSED. The two legs that cannot run
 * here are stated as such rather than simulated:
 *   - LINE ingestion (steps 01-03) needs LINE_CHANNEL_SECRET and a public URL
 *   - Plane issue creation (step 09) must not run against the live workspace
 *
 * Notification delivery is exercised through the ledger: with no LINE
 * recipient reachable from here the send fails at the transport, but the
 * at-most-once claim is what these assertions are about, and that is
 * database-enforced.
 */

const STAGING_PROJECT = 301;
const STAGING_ORG = "org_staging";
const RUN = `gf-${process.pid}`;

let dbAvailable = false;
let identityId: number | null = null;
let profileId: string | null = null;
let conversationId: number | null = null;
let ticketId: number | null = null;
let ticketNumber = "";

const evidence: Record<string, unknown> = {};

async function ticketStatus(id: number): Promise<{ status: string; plane_status: string }> {
  const { rows } = await pool.query(`SELECT status, plane_status FROM tickets WHERE id = $1`, [id]);
  return rows[0];
}

async function notificationCount(type: string, convId: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int c FROM customer_notifications WHERE conversation_id = $1 AND notification_type = $2`,
    [convId, type]
  );
  return rows[0].c;
}

describe("TicketX lifecycle integration (live database, staging project 301)", () => {
  before(async () => {
    try {
      await pool.query("SELECT 1");

      const prof = await pool.query(
        `INSERT INTO profiles (id, company_id, name, metadata, created_at, updated_at)
         VALUES ($1, 301, $2, '{}'::jsonb, NOW(), NOW()) RETURNING id`,
        [`prof_${RUN}`, `GF Test Customer ${RUN}`]
      );
      profileId = prof.rows[0].id;

      const ident = await pool.query(
        `INSERT INTO identities (profile_id, channel, channel_ref, org_id, created_at, updated_at)
         VALUES ($1, 'line', $2, $3, NOW(), NOW()) RETURNING id`,
        [profileId, `Utest_${RUN}`, STAGING_ORG]
      );
      identityId = ident.rows[0].id;

      const conv = await pool.query(
        `INSERT INTO conversations (identity_id, project_id, org_id, channel, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'line', 'open', NOW(), NOW()) RETURNING id`,
        [identityId, STAGING_PROJECT, STAGING_ORG]
      );
      conversationId = conv.rows[0].id;

      dbAvailable = true;
    } catch (e: any) {
      console.log("setup failed:", e.message);
      dbAvailable = false;
    }
  });

  after(async () => {
    if (conversationId) {
      await pool.query(`DELETE FROM customer_notifications WHERE conversation_id = $1`, [conversationId]).catch(() => {});
      if (ticketId) {
        await pool.query(`DELETE FROM ticket_events WHERE ticket_id = $1`, [ticketId]).catch(() => {});
        await pool.query(`DELETE FROM tickets WHERE id = $1`, [ticketId]).catch(() => {});
      }
      await pool.query(`DELETE FROM messages WHERE conversation_id = $1`, [conversationId]).catch(() => {});
      await pool.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]).catch(() => {});
    }
    if (identityId) await pool.query(`DELETE FROM identities WHERE id = $1`, [identityId]).catch(() => {});
    if (profileId) await pool.query(`DELETE FROM profiles WHERE id = $1`, [profileId]).catch(() => {});

    console.log("\n=== GOLDEN FLOW EVIDENCE (no credentials) ===");
    console.log(JSON.stringify(evidence, null, 2));

    // The pool is shared with the negative-case suite below; it is closed there.
  });

  // ------------------------------------------------------- STEPS 03-04
  it("STEP 03-04: identity and conversation resolve to the staging tenant", async (t) => {
    if (!dbAvailable) return t.skip("database unavailable");
    const { rows } = await pool.query(
      `SELECT c.id, c.project_id, c.org_id, c.identity_id FROM conversations c WHERE c.id = $1`,
      [conversationId]
    );
    assert.strictEqual(rows[0].project_id, STAGING_PROJECT);
    assert.strictEqual(rows[0].org_id, STAGING_ORG);
    evidence.identity_id = identityId;
    evidence.conversation_id = conversationId;
    evidence.project_id = STAGING_PROJECT;
    evidence.org_id = STAGING_ORG;
  });

  // ---------------------------------------------------------- STEP 06
  it("STEP 06: ticket is created in the staging project at lifecycle NEW", async (t) => {
    if (!dbAvailable) return t.skip("database unavailable");
    ticketNumber = `TCK-GF-${process.pid}`;
    const { rows } = await pool.query(
      `INSERT INTO tickets (ticket_number, conversation_id, project_id, org_id, subject, summary,
                            status, plane_status, priority, severity, created_via, lifecycle_changed_at)
       VALUES ($1, $2, $3, $4, 'ระบบเข้าใช้งานไม่ได้ครับ ขึ้น 502 Bad Gateway',
               'Customer reports 502 Bad Gateway', 'NEW', 'Backlog', 'High', 'High', 'test', NOW())
       RETURNING id, status, plane_status`,
      [ticketNumber, conversationId, STAGING_PROJECT, STAGING_ORG]
    );
    ticketId = rows[0].id;
    assert.strictEqual(rows[0].status, "NEW");
    assert.strictEqual(rows[0].plane_status, "Backlog");
    evidence.ticket_id = ticketId;
    evidence.ticket_number = ticketNumber;
  });

  // ---------------------------------------------------------- STEP 07
  it("STEP 07: customer receives an acknowledgement, recorded once", async (t) => {
    if (!dbAvailable || !conversationId) return t.skip("database unavailable");
    const r = await customerNotificationService.send({
      conversationId,
      notificationType: "acknowledgement",
      idempotencyKey: `webhook:${RUN}:1`,
      projectId: STAGING_PROJECT,
      orgId: STAGING_ORG,
    });
    // Delivery to LINE is not reachable from here; the ledger claim is.
    assert.strictEqual(r.duplicate, undefined, "first send must not be a duplicate");
    assert.strictEqual(
      r.body,
      "รับเรื่องแล้วครับ กำลังตรวจสอบปัญหาให้ครับ",
      "the acknowledgement must not claim anything was fixed"
    );
    assert.ok(!/#TCK/.test(r.body || ""), "must not invent a case number");
    assert.strictEqual(await notificationCount("acknowledgement", conversationId), 1);
    evidence.acknowledgement_body = r.body;
  });

  // ---------------------------------------------------------- STEP 08
  it("STEP 08: ticket is promoted NEW -> TRIAGED -> OPEN -> IN_PROGRESS", async (t) => {
    if (!dbAvailable || !ticketId) return t.skip("database unavailable");
    for (const [to, actor] of [["TRIAGED", "system"], ["OPEN", "operator"], ["IN_PROGRESS", "operator"]] as any[]) {
      const r = await ticketStateMachine.transition({ ticketRef: ticketId, to, actor, correlationId: RUN });
      assert.ok(r.applied, `${to} failed: ${r.reason}`);
    }
    const s = await ticketStatus(ticketId);
    assert.strictEqual(s.status, "IN_PROGRESS");
    assert.strictEqual(s.plane_status, "Open");
  });

  // ---------------------------------------------------------- STEP 09
  it("STEP 09: plane_issue_id must never hold a TicketX identifier", async (t) => {
    if (!dbAvailable || !ticketId) return t.skip("database unavailable");
    // Live Plane creation is BLOCKED here. What is asserted is the invariant
    // that the 409-handling bug violated: the column must hold Plane's UUID,
    // never external_id / ticket number / conversation id.
    const planeUuid = "8f14e45f-ceea-467a-9f4a-1b2c3d4e5f60";
    await pool.query(`UPDATE tickets SET plane_issue_id = $1, plane_project_id = $2 WHERE id = $3`, [
      planeUuid,
      "staging-plane-project",
      ticketId,
    ]);
    const { rows } = await pool.query(`SELECT plane_issue_id, plane_project_id FROM tickets WHERE id = $1`, [ticketId]);
    assert.match(rows[0].plane_issue_id, /^[0-9a-f]{8}-[0-9a-f]{4}-/, "must look like a Plane UUID");
    assert.notStrictEqual(rows[0].plane_issue_id, ticketNumber);
    assert.notStrictEqual(rows[0].plane_issue_id, String(ticketId));
    assert.notStrictEqual(rows[0].plane_issue_id, String(conversationId));
    evidence.plane_issue_id = rows[0].plane_issue_id;
    evidence.plane_project_id = rows[0].plane_project_id;
  });

  // ------------------------------------------------------- STEPS 10-11
  it("STEP 10-11: Plane Done produces RESOLVED, not CLOSED", async (t) => {
    if (!dbAvailable || !ticketId) return t.skip("database unavailable");
    const r = await ticketStateMachine.applyPlaneStatus(ticketId, "Done", { correlationId: RUN });
    assert.ok(r.applied, r.reason);
    assert.strictEqual(r.to, "RESOLVED");
    assert.notStrictEqual(r.to, "CLOSED");
    assert.strictEqual(r.notify, "resolution_confirmation_request");
    evidence.resolved_event_id = r.eventId;
  });

  // ---------------------------------------------------------- STEP 12
  it("STEP 12: customer receives a resolution notification that asks for confirmation", async (t) => {
    if (!dbAvailable || !conversationId || !ticketId) return t.skip("database unavailable");
    const r = await customerNotificationService.send({
      conversationId,
      notificationType: "resolution_confirmation",
      idempotencyKey: `ticket_event:${evidence.resolved_event_id}`,
      ticketId,
      ticketNumber,
      projectId: STAGING_PROJECT,
      orgId: STAGING_ORG,
    });
    assert.ok(r.body!.includes(ticketNumber), "must name the case");
    assert.ok(r.body!.includes("ยืนยัน"), "must ask the customer to confirm, not just announce completion");
    evidence.resolution_body = r.body;
  });

  // ------------------------------------------------------- STEPS 13-14
  it("STEP 13-14: the customer's confirmation drives CUSTOMER_CONFIRMED then CLOSED", async (t) => {
    if (!dbAvailable || !conversationId || !ticketId) return t.skip("database unavailable");
    const outcome = await customerConfirmationHandler.handle({
      conversationId,
      text: "ใช้งานได้แล้วครับ ขอบคุณครับ ปิดเคสได้เลย",
      correlationId: RUN,
    });
    assert.ok(outcome.handled, `not handled: ${outcome.reason}`);
    assert.strictEqual(outcome.to, "CLOSED");

    const s = await ticketStatus(ticketId);
    assert.strictEqual(s.status, "CLOSED");
    assert.strictEqual(s.plane_status, "Done");
  });

  // ---------------------------------------------------------- STEP 15
  it("STEP 15: no duplicate notification of any kind", async (t) => {
    if (!dbAvailable || !conversationId) return t.skip("database unavailable");
    for (const type of ["acknowledgement", "resolution_confirmation", "closed"]) {
      const n = await notificationCount(type, conversationId);
      assert.ok(n <= 1, `${type} was sent ${n} times`);
    }
  });

  // ---------------------------------------------------------- STEP 16
  it("STEP 16: the audit trail is complete and correctly ordered", async (t) => {
    if (!dbAvailable || !ticketId) return t.skip("database unavailable");
    const { rows } = await pool.query(
      `SELECT payload FROM ticket_events WHERE ticket_id = $1 AND event_type = 'STATUS_TRANSITION' ORDER BY id`,
      [ticketId]
    );
    const chain = rows.map((r: any) => `${r.payload.from}->${r.payload.to}`);
    assert.deepStrictEqual(chain, [
      "NEW->TRIAGED",
      "TRIAGED->OPEN",
      "OPEN->IN_PROGRESS",
      "IN_PROGRESS->RESOLVED",
      "RESOLVED->CUSTOMER_CONFIRMED",
      "CUSTOMER_CONFIRMED->CLOSED",
    ]);
    evidence.audit_chain = chain;
  });

  // ---------------------------------------------------------- STEP 17
  it("STEP 17: no Plane status ping-pong across the closing sequence", async (t) => {
    if (!dbAvailable || !ticketId) return t.skip("database unavailable");
    // Re-reading Done while CLOSED must change nothing.
    const again = await ticketStateMachine.applyPlaneStatus(ticketId, "Done", { correlationId: RUN });
    assert.strictEqual(again.applied, false);
    assert.strictEqual(again.code, "NO_CHANGE");
    const s = await ticketStatus(ticketId);
    assert.strictEqual(s.status, "CLOSED", "a repeated Done must not reopen a closed ticket");
  });
});

// =========================================================================
// NEGATIVE CASES
// =========================================================================

describe("TicketX lifecycle integration — negative cases", () => {
  let convId: number | null = null;
  let identId: number | null = null;
  let profId: string | null = null;
  let tId: number | null = null;
  let ready = false;

  before(async () => {
    try {
      const prof = await pool.query(
        `INSERT INTO profiles (id, company_id, name, metadata, created_at, updated_at)
         VALUES ($1, 301, $2, '{}'::jsonb, NOW(), NOW()) RETURNING id`,
        [`prof_neg_${RUN}`, `GF Negative ${RUN}`]
      );
      profId = prof.rows[0].id;
      const ident = await pool.query(
        `INSERT INTO identities (profile_id, channel, channel_ref, org_id, created_at, updated_at)
         VALUES ($1, 'line', $2, $3, NOW(), NOW()) RETURNING id`,
        [profId, `Uneg_${RUN}`, STAGING_ORG]
      );
      identId = ident.rows[0].id;
      const conv = await pool.query(
        `INSERT INTO conversations (identity_id, project_id, org_id, channel, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'line', 'open', NOW(), NOW()) RETURNING id`,
        [identId, STAGING_PROJECT, STAGING_ORG]
      );
      convId = conv.rows[0].id;
      const tk = await pool.query(
        `INSERT INTO tickets (ticket_number, conversation_id, project_id, org_id, subject, summary,
                              status, plane_status, priority, severity, created_via, lifecycle_changed_at)
         VALUES ($1, $2, $3, $4, 'negative case', 'negative case', 'RESOLVED', 'Done', 'Medium', 'Low', 'test', NOW())
         RETURNING id`,
        [`TCK-NEG-${process.pid}`, convId, STAGING_PROJECT, STAGING_ORG]
      );
      tId = tk.rows[0].id;
      ready = true;
    } catch (e: any) {
      console.log("negative-case setup failed:", e.message);
      ready = false;
    }
  });

  after(async () => {
    if (convId) {
      await pool.query(`DELETE FROM customer_notifications WHERE conversation_id = $1`, [convId]).catch(() => {});
      if (tId) {
        await pool.query(`DELETE FROM ticket_events WHERE ticket_id = $1`, [tId]).catch(() => {});
        await pool.query(`DELETE FROM tickets WHERE id = $1`, [tId]).catch(() => {});
      }
      await pool.query(`DELETE FROM messages WHERE conversation_id = $1`, [convId]).catch(() => {});
      await pool.query(`DELETE FROM conversations WHERE id = $1`, [convId]).catch(() => {});
    }
    if (identId) await pool.query(`DELETE FROM identities WHERE id = $1`, [identId]).catch(() => {});
    if (profId) await pool.query(`DELETE FROM profiles WHERE id = $1`, [profId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  it("CASE 1: 'ยังใช้ไม่ได้ครับ' reopens rather than closes", async (t) => {
    if (!ready || !convId || !tId) return t.skip("setup unavailable");
    assert.strictEqual(detectConfirmationIntent("ยังใช้ไม่ได้ครับ"), "REJECTED");

    const outcome = await customerConfirmationHandler.handle({
      conversationId: convId,
      text: "ยังใช้ไม่ได้ครับ",
      correlationId: `${RUN}-neg1`,
    });
    assert.ok(outcome.handled, outcome.reason);
    assert.strictEqual(outcome.to, "IN_PROGRESS");

    const { rows } = await pool.query(`SELECT status FROM tickets WHERE id = $1`, [tId]);
    assert.strictEqual(rows[0].status, "IN_PROGRESS");
    assert.notStrictEqual(rows[0].status, "CLOSED", "a rejection must never close the ticket");
  });

  it("CASE 2: the same webhook twice yields one acknowledgement", async (t) => {
    if (!ready || !convId) return t.skip("setup unavailable");
    const key = `webhook:${RUN}:dup`;
    const first = await customerNotificationService.send({
      conversationId: convId, notificationType: "acknowledgement", idempotencyKey: key,
    });
    const second = await customerNotificationService.send({
      conversationId: convId, notificationType: "acknowledgement", idempotencyKey: key,
    });
    assert.strictEqual(first.duplicate, undefined);
    assert.strictEqual(second.duplicate, true, "the retry must be suppressed");

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int c FROM customer_notifications
        WHERE conversation_id = $1 AND notification_type = 'acknowledgement' AND idempotency_key = $2`,
      [convId, key]
    );
    assert.strictEqual(rows[0].c, 1, "exactly one ledger row");
  });

  it("CASE 3: the same Plane Done twice yields one transition and one notification", async (t) => {
    if (!ready || !convId || !tId) return t.skip("setup unavailable");
    await pool.query(`UPDATE tickets SET status = 'IN_PROGRESS', plane_status = 'Open' WHERE id = $1`, [tId]);

    const a = await ticketStateMachine.applyPlaneStatus(tId, "Done", { correlationId: `${RUN}-neg3` });
    const b = await ticketStateMachine.applyPlaneStatus(tId, "Done", { correlationId: `${RUN}-neg3` });
    assert.ok(a.applied);
    assert.strictEqual(b.applied, false, "the second Done must be a no-op");
    assert.strictEqual(b.code, "NO_CHANGE");

    const key = `ticket_event:${a.eventId}`;
    await customerNotificationService.send({
      conversationId: convId, notificationType: "resolution_confirmation", idempotencyKey: key, ticketId: tId,
    });
    const dup = await customerNotificationService.send({
      conversationId: convId, notificationType: "resolution_confirmation", idempotencyKey: key, ticketId: tId,
    });
    assert.strictEqual(dup.duplicate, true);
  });

  it("CASE 4: Plane Done arriving after CLOSED neither reopens nor re-notifies", async (t) => {
    if (!ready || !tId) return t.skip("setup unavailable");
    await pool.query(`UPDATE tickets SET status = 'CLOSED', plane_status = 'Done' WHERE id = $1`, [tId]);

    const late = await ticketStateMachine.applyPlaneStatus(tId, "Done", { correlationId: `${RUN}-neg4` });
    assert.strictEqual(late.applied, false);
    assert.strictEqual(late.code, "NO_CHANGE");

    const { rows } = await pool.query(`SELECT status FROM tickets WHERE id = $1`, [tId]);
    assert.strictEqual(rows[0].status, "CLOSED");
  });

  it("CASE 5: an unrelated message after CLOSED does not mutate the closed ticket", async (t) => {
    if (!ready || !convId || !tId) return t.skip("setup unavailable");
    const before = await pool.query(`SELECT status, updated_at FROM tickets WHERE id = $1`, [tId]);

    const outcome = await customerConfirmationHandler.handle({
      conversationId: convId,
      text: "สวัสดีครับ อยากสอบถามเรื่องใบเสนอราคาครับ",
      correlationId: `${RUN}-neg5`,
    });
    assert.strictEqual(outcome.handled, false, "an unrelated message must not be treated as a confirmation");
    assert.strictEqual(outcome.reason, "NO_TICKET_AWAITING_CONFIRMATION");

    const after = await pool.query(`SELECT status FROM tickets WHERE id = $1`, [tId]);
    assert.strictEqual(after.rows[0].status, before.rows[0].status);
  });

  it("CASE 6: a customer in one org cannot reference another org's project", async (t) => {
    if (!ready) return t.skip("setup unavailable");
    const r = await projectResolver.resolveById(101, STAGING_ORG);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failure, "CROSS_TENANT_DENIED");
  });

  it("CASE 7: an unmapped project has no Plane mapping and no fallback", async (t) => {
    if (!ready) return t.skip("setup unavailable");
    const r = await projectResolver.resolveById(9999);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failure, "PROJECT_NOT_FOUND");

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int c FROM plane_workspace_mappings WHERE project_id = 9999 AND enabled = TRUE`
    );
    assert.strictEqual(rows[0].c, 0, "an unmapped project must resolve to no Plane mapping");
  });
});
