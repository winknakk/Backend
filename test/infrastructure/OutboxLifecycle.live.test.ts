import assert from "assert";
import { describe, it, before, after } from "node:test";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { pool } from "../../src/adapters/postgres/PostgresAdapter";
import { PostgresOutboxRepository } from "../../src/infrastructure/db/PostgresOutboxRepository";
import { requiresIsolatedDatabase } from "../support/testDatabase";

/**
 * Outbox states against the real table: pending -> due -> retry -> dead
 * letter -> replay, plus duplicate and out-of-order events.
 *
 * Uses rows created and removed by the test. Skips cleanly when the database
 * is unreachable rather than failing the suite for an environment reason.
 */

const repo = new PostgresOutboxRepository();
const AGG = `qa-outbox-${process.pid}`;
let dbAvailable = false;
let isolationSkip: string | undefined;
const created: number[] = [];

async function insertEvent(eventType: string, payload: any): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status, attempts, created_at)
     VALUES ('qa', $1, $2, $3, 'pending', 0, NOW()) RETURNING id`,
    [AGG, eventType, JSON.stringify(payload)]
  );
  created.push(rows[0].id);
  return rows[0].id;
}

async function statusOf(id: number) {
  const { rows } = await pool.query(
    `SELECT status, attempts, failure_kind, next_attempt_at, dead_lettered_at FROM outbox_events WHERE id = $1`,
    [id]
  );
  return rows[0];
}

describe("Outbox lifecycle (live database)", () => {
  before(async () => {
    // These insert pending outbox rows. A deployed backend polling the same
    // database picks them up within seconds - proven by probe, which is why
    // this suite raced production and intermittently failed. Without an
    // isolated database it refuses to run rather than writing there.
    const decision = requiresIsolatedDatabase();
    if (!decision.allowed) {
      isolationSkip = decision.skipReason;
      return;
    }
    try {
      await pool.query("SELECT 1");
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  after(async () => {
    if (created.length > 0) {
      await pool.query(`DELETE FROM outbox_events WHERE id = ANY($1::int[])`, [created]).catch(() => {});
    }
    await pool.end().catch(() => {});
  });

  it("OUT-001: a pending event is due immediately", async (t) => {
    if (isolationSkip) return t.skip(isolationSkip);
    if (!dbAvailable) return t.skip("database unavailable");
    const id = await insertEvent("QaPending", { n: 1 });
    const due = await repo.fetchPending(500);
    assert.ok(due.some((e: any) => e.id === id), "a fresh pending event must be due");
  });

  it("OUT-002: a successful dispatch marks the event processed", async (t) => {
    if (isolationSkip) return t.skip(isolationSkip);
    if (!dbAvailable) return t.skip("database unavailable");
    const id = await insertEvent("QaSuccess", { n: 2 });
    await repo.markProcessed(id);
    assert.strictEqual((await statusOf(id)).status, "processed");

    const due = await repo.fetchPending(500);
    assert.ok(!due.some((e: any) => e.id === id), "a processed event must not be re-fetched");
  });

  it("OUT-003: a retryable failure stays pending but is not due until its backoff elapses", async (t) => {
    if (isolationSkip) return t.skip(isolationSkip);
    if (!dbAvailable) return t.skip("database unavailable");
    const id = await insertEvent("QaTransient", { n: 3 });
    await repo.scheduleRetry(id, 1, "503 Service Unavailable", 60_000);

    const row = await statusOf(id);
    assert.strictEqual(row.status, "pending");
    assert.strictEqual(row.attempts, 1);
    assert.strictEqual(row.failure_kind, "transient");
    assert.ok(row.next_attempt_at, "next_attempt_at must be set");

    const due = await repo.fetchPending(500);
    assert.ok(
      !due.some((e: any) => e.id === id),
      "an event in backoff must not be re-fetched — this is what stopped the 10-second hammering"
    );
  });

  it("OUT-004: a retry becomes due once its backoff has passed", async (t) => {
    if (isolationSkip) return t.skip(isolationSkip);
    if (!dbAvailable) return t.skip("database unavailable");
    const id = await insertEvent("QaDue", { n: 4 });
    await repo.scheduleRetry(id, 1, "503", -1000); // already elapsed
    const due = await repo.fetchPending(500);
    assert.ok(due.some((e: any) => e.id === id), "an elapsed backoff must make the event due again");
  });

  it("OUT-005: a permanent failure is dead-lettered and never re-fetched", async (t) => {
    if (isolationSkip) return t.skip(isolationSkip);
    if (!dbAvailable) return t.skip("database unavailable");
    const id = await insertEvent("QaPermanent", { n: 5 });
    await repo.deadLetter(id, 1, "Custom Id cannot be integers", "permanent");

    const row = await statusOf(id);
    assert.strictEqual(row.status, "dead_letter");
    assert.strictEqual(row.failure_kind, "permanent");
    assert.ok(row.dead_lettered_at);
    assert.strictEqual(row.next_attempt_at, null, "a dead letter must have no scheduled retry");

    const due = await repo.fetchPending(500);
    assert.ok(!due.some((e: any) => e.id === id), "a dead letter must never be picked up automatically");
  });

  it("OUT-006: a blocked failure is dead-lettered separately from a permanent one", async (t) => {
    if (isolationSkip) return t.skip(isolationSkip);
    if (!dbAvailable) return t.skip("database unavailable");
    const id = await insertEvent("QaBlocked", { n: 6 });
    await repo.deadLetter(id, 1, "Request failed with status code 403", "blocked");
    assert.strictEqual((await statusOf(id)).failure_kind, "blocked");

    const counts = await repo.countDeadLettersByKind();
    assert.ok(counts.some((c) => c.failure_kind === "blocked"), "blocked must be visible as its own kind");
  });

  it("OUT-007: replay returns a dead letter to the queue with a fresh budget", async (t) => {
    if (isolationSkip) return t.skip(isolationSkip);
    if (!dbAvailable) return t.skip("database unavailable");
    const id = await insertEvent("QaReplay", { n: 7 });
    await repo.deadLetter(id, 5, "503", "transient");

    assert.strictEqual(await repo.requeueDeadLetter(id), true);
    const row = await statusOf(id);
    assert.strictEqual(row.status, "pending");
    assert.strictEqual(row.attempts, 0, "replay must reset the retry budget");
    assert.strictEqual(row.failure_kind, null);
    assert.strictEqual(row.dead_lettered_at, null);

    const due = await repo.fetchPending(500);
    assert.ok(due.some((e: any) => e.id === id), "a replayed event must be due again");
  });

  it("OUT-008: replaying something that is not a dead letter is refused", async (t) => {
    if (isolationSkip) return t.skip(isolationSkip);
    if (!dbAvailable) return t.skip("database unavailable");
    const id = await insertEvent("QaNotDead", { n: 8 });
    assert.strictEqual(await repo.requeueDeadLetter(id), false, "only dead letters may be requeued");
    assert.strictEqual(await repo.requeueDeadLetter(999999999), false, "unknown id must not throw");
  });

  it("OUT-009: duplicate events are independent rows and do not corrupt each other", async (t) => {
    if (isolationSkip) return t.skip(isolationSkip);
    if (!dbAvailable) return t.skip("database unavailable");
    const a = await insertEvent("QaDuplicate", { ticketId: "TCK-DUP" });
    const b = await insertEvent("QaDuplicate", { ticketId: "TCK-DUP" });
    assert.notStrictEqual(a, b);

    await repo.markProcessed(a);
    await repo.deadLetter(b, 1, "duplicate", "permanent");

    assert.strictEqual((await statusOf(a)).status, "processed");
    assert.strictEqual((await statusOf(b)).status, "dead_letter");
  });

  it("OUT-010: events are dispatched oldest-first regardless of insertion order of state changes", async (t) => {
    if (isolationSkip) return t.skip(isolationSkip);
    if (!dbAvailable) return t.skip("database unavailable");
    const first = await insertEvent("QaOrderA", { seq: 1 });
    const second = await insertEvent("QaOrderB", { seq: 2 });

    // Touch the older row last; ordering must still be by id, not by update time.
    await pool.query(`UPDATE outbox_events SET updated_at = NOW() WHERE id = $1`, [first]);

    const due = await repo.fetchPending(500);
    const ours = due.filter((e: any) => e.id === first || e.id === second).map((e: any) => e.id);
    assert.deepStrictEqual(ours, [first, second], "ordering must be stable and oldest-first");
  });
});
