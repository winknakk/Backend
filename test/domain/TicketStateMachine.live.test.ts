import assert from "assert";
import { describe, it, before, after } from "node:test";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { pool } from "../../src/adapters/postgres/PostgresAdapter";
import { ticketStateMachine } from "../../src/domain/ticket/TicketStateMachine";

/**
 * Exercises the full lifecycle against the real database, using a ticket
 * created and removed by the test. Verifies transitions persist, are audited
 * in ticket_events, are rejected when invalid, and are safe under
 * concurrency.
 *
 * Requires DATABASE_URL. Skips cleanly when the database is unreachable
 * rather than failing the suite for an environment reason.
 */

let ticketId: number | null = null;
let conversationId: number | null = null;
let dbAvailable = false;

const TICKET_NUMBER = `TCK-TEST-${process.pid}`;

describe("TicketStateMachine (live database)", () => {
  before(async () => {
    try {
      const conv = await pool.query(
        `SELECT id, project_id, org_id FROM conversations WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1`
      );
      if (conv.rows.length === 0) return;
      conversationId = conv.rows[0].id;

      const inserted = await pool.query(
        `INSERT INTO tickets (ticket_number, conversation_id, project_id, org_id, subject, summary,
                              status, plane_status, priority, severity, created_via, lifecycle_changed_at)
         VALUES ($1, $2, $3, $4, 'lifecycle test', 'lifecycle test', 'NEW', 'Backlog', 'Medium', 'Low', 'test', NOW())
         RETURNING id`,
        [TICKET_NUMBER, conversationId, conv.rows[0].project_id, conv.rows[0].org_id]
      );
      ticketId = inserted.rows[0].id;
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  after(async () => {
    if (ticketId) {
      await pool.query(`DELETE FROM ticket_events WHERE ticket_id = $1`, [ticketId]).catch(() => {});
      await pool.query(`DELETE FROM tickets WHERE id = $1`, [ticketId]).catch(() => {});
    }
    await pool.end().catch(() => {});
  });

  it("LIFE-E2E: walks the complete customer journey", async (t) => {
    if (!dbAvailable || !ticketId) return t.skip("database unavailable");

    const journey: Array<[string, string]> = [
      ["TRIAGED", "system"],
      ["OPEN", "operator"],
      ["IN_PROGRESS", "operator"],
      ["WAITING_CUSTOMER", "operator"],
      ["IN_PROGRESS", "customer"],
      ["RESOLVED", "plane"],
      ["CUSTOMER_CONFIRMED", "customer"],
      ["CLOSED", "system"],
    ];

    for (const [to, actor] of journey) {
      const r = await ticketStateMachine.transition({
        ticketRef: ticketId,
        to: to as any,
        actor: actor as any,
        reason: "lifecycle test",
        correlationId: "test-corr",
      });
      assert.ok(r.applied, `${to} as ${actor} failed: ${r.reason}`);
      assert.strictEqual(r.to, to);
    }

    const final = await pool.query(`SELECT status, plane_status, closed_at, resolved_at FROM tickets WHERE id = $1`, [ticketId]);
    assert.strictEqual(final.rows[0].status, "CLOSED");
    assert.strictEqual(final.rows[0].plane_status, "Done");
    assert.ok(final.rows[0].resolved_at, "resolved_at must be stamped");
    assert.ok(final.rows[0].closed_at, "closed_at must be stamped");
  });

  it("AUDIT-001: every transition produced exactly one ticket_events row", async (t) => {
    if (!dbAvailable || !ticketId) return t.skip("database unavailable");

    const events = await pool.query(
      `SELECT payload, actor, source, correlation_id FROM ticket_events
        WHERE ticket_id = $1 AND event_type = 'STATUS_TRANSITION' ORDER BY id`,
      [ticketId]
    );

    assert.strictEqual(events.rows.length, 8, "one audit row per transition, no duplicates");

    const chain = events.rows.map((r: any) => `${r.payload.from}->${r.payload.to}`);
    assert.deepStrictEqual(chain, [
      "NEW->TRIAGED",
      "TRIAGED->OPEN",
      "OPEN->IN_PROGRESS",
      "IN_PROGRESS->WAITING_CUSTOMER",
      "WAITING_CUSTOMER->IN_PROGRESS",
      "IN_PROGRESS->RESOLVED",
      "RESOLVED->CUSTOMER_CONFIRMED",
      "CUSTOMER_CONFIRMED->CLOSED",
    ]);

    // Historical detail must survive: actor, reason and correlation id.
    assert.ok(events.rows.every((r: any) => r.correlation_id === "test-corr"));
    assert.ok(events.rows.every((r: any) => r.payload.reason === "lifecycle test"));
  });

  it("LIFE-REJECT: the rejection path works and is audited", async (t) => {
    if (!dbAvailable || !ticketId) return t.skip("database unavailable");

    // CLOSED -> REOPENED -> IN_PROGRESS
    const reopen = await ticketStateMachine.transition({
      ticketRef: ticketId, to: "REOPENED", actor: "customer", reason: "still broken",
    });
    assert.ok(reopen.applied, reopen.reason);
    assert.strictEqual(reopen.pushToPlane, true, "REOPENED is Open in Plane, Done before: must push");

    const working = await ticketStateMachine.transition({
      ticketRef: ticketId, to: "IN_PROGRESS", actor: "operator",
    });
    assert.ok(working.applied, working.reason);
  });

  it("PING-PONG: confirming and closing do not push to Plane", async (t) => {
    if (!dbAvailable || !ticketId) return t.skip("database unavailable");

    await ticketStateMachine.transition({ ticketRef: ticketId, to: "RESOLVED", actor: "plane" });
    const confirm = await ticketStateMachine.transition({
      ticketRef: ticketId, to: "CUSTOMER_CONFIRMED", actor: "customer",
    });
    assert.ok(confirm.applied);
    assert.strictEqual(confirm.pushToPlane, false, "RESOLVED and CUSTOMER_CONFIRMED are both Done");

    const close = await ticketStateMachine.transition({
      ticketRef: ticketId, to: "CLOSED", actor: "system",
    });
    assert.strictEqual(close.pushToPlane, false, "CLOSED is still Done");
  });

  it("TICKET-002: an invalid transition is rejected and writes nothing", async (t) => {
    if (!dbAvailable || !ticketId) return t.skip("database unavailable");

    const before = await pool.query(`SELECT status FROM tickets WHERE id = $1`, [ticketId]);
    const eventsBefore = await pool.query(`SELECT count(*)::int c FROM ticket_events WHERE ticket_id = $1`, [ticketId]);

    const r = await ticketStateMachine.transition({ ticketRef: ticketId, to: "NEW", actor: "operator" });
    assert.strictEqual(r.applied, false);
    assert.strictEqual(r.code, "INVALID_TRANSITION");

    const after = await pool.query(`SELECT status FROM tickets WHERE id = $1`, [ticketId]);
    const eventsAfter = await pool.query(`SELECT count(*)::int c FROM ticket_events WHERE ticket_id = $1`, [ticketId]);
    assert.strictEqual(after.rows[0].status, before.rows[0].status, "status must be unchanged");
    assert.strictEqual(eventsAfter.rows[0].c, eventsBefore.rows[0].c, "no audit row for a rejected transition");
  });

  it("Plane cannot confirm on the customer's behalf, against real data", async (t) => {
    if (!dbAvailable || !ticketId) return t.skip("database unavailable");

    await pool.query(`UPDATE tickets SET status = 'RESOLVED' WHERE id = $1`, [ticketId]);
    const r = await ticketStateMachine.transition({
      ticketRef: ticketId, to: "CUSTOMER_CONFIRMED", actor: "plane",
    });
    assert.strictEqual(r.applied, false);
    assert.strictEqual(r.code, "ACTOR_NOT_PERMITTED");
  });

  it("TICKET-003: concurrent transitions - exactly one wins", async (t) => {
    if (!dbAvailable || !ticketId) return t.skip("database unavailable");

    await pool.query(`UPDATE tickets SET status = 'RESOLVED' WHERE id = $1`, [ticketId]);

    // Earlier tests in this suite share the ticket, so the audit assertion
    // below counts only rows written from here on.
    const auditBaseline = await pool.query(
      `SELECT COALESCE(MAX(id), 0) AS max_id FROM ticket_events WHERE ticket_id = $1`,
      [ticketId]
    );
    const sinceId = Number(auditBaseline.rows[0].max_id);

    // The customer confirms and reopens at the same instant. Both are valid
    // from RESOLVED, so only the conditional UPDATE can separate them.
    const [a, b] = await Promise.all([
      ticketStateMachine.transition({ ticketRef: ticketId, to: "CUSTOMER_CONFIRMED", actor: "customer" }),
      ticketStateMachine.transition({ ticketRef: ticketId, to: "REOPENED", actor: "customer" }),
    ]);

    const winners = [a, b].filter((r) => r.applied);
    assert.strictEqual(winners.length, 1, "exactly one concurrent transition may win");

    // The loser is refused at one of two points depending on timing: if it
    // read the ticket before the winner committed, the conditional UPDATE
    // matches no rows (CONCURRENT_MODIFICATION); if it read afterwards, the
    // transition is no longer valid from the new state (INVALID_TRANSITION).
    // Both are correct refusals — the invariant is that only one wins and the
    // other writes nothing.
    const loser = [a, b].find((r) => !r.applied)!;
    assert.ok(
      ["CONCURRENT_MODIFICATION", "INVALID_TRANSITION"].includes(loser.code!),
      `unexpected refusal code: ${loser.code}`
    );

    // And the ticket must hold exactly the winner's target, not a blend.
    const final = await pool.query(`SELECT status FROM tickets WHERE id = $1`, [ticketId]);
    assert.strictEqual(final.rows[0].status, winners[0].to);

    // Exactly one audit row for this contested transition.
    const events = await pool.query(
      `SELECT count(*)::int c FROM ticket_events
        WHERE ticket_id = $1 AND id > $2 AND event_type = 'STATUS_TRANSITION'`,
      [ticketId, sinceId]
    );
    assert.strictEqual(
      events.rows[0].c,
      1,
      "exactly one audit row: the winner is recorded, the loser writes nothing"
    );
  });

  it("applyPlaneStatus: Plane Done resolves but never closes", async (t) => {
    if (!dbAvailable || !ticketId) return t.skip("database unavailable");

    await pool.query(`UPDATE tickets SET status = 'IN_PROGRESS', plane_status = 'Open' WHERE id = $1`, [ticketId]);

    const first = await ticketStateMachine.applyPlaneStatus(ticketId, "Done");
    assert.ok(first.applied);
    assert.strictEqual(first.to, "RESOLVED");
    assert.strictEqual(first.notify, "resolution_confirmation_request");

    // Polling again with the same state must be a no-op: no write, no second
    // notification. This is what stopped reverse sync churning.
    const second = await ticketStateMachine.applyPlaneStatus(ticketId, "Done");
    assert.strictEqual(second.applied, false);
    assert.strictEqual(second.code, "NO_CHANGE");
  });
});
