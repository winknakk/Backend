/**
 * AuditService transaction correctness — live test against an ISOLATED database.
 *
 * Refuses to run unless DATABASE_URL is a local database whose name contains
 * "test". Contract under test: inside a caller's transaction the audit row is
 * part of the operation — success persists both, an audit failure rolls the
 * whole operation back and is reported as an error (never HTTP 200).
 *
 *  1. success: business write and audit row (entity_type/entity_id) both persist
 *  2. audit failure in a caller transaction: record() throws, business write
 *     rolled back (plus a control reproducing the old silent rollback)
 *  3. ticket merge route: merge, internal note and audit row committed
 *  4. DLQ requeue route: outbox state changed and audited
 *  5. DLQ requeue with a forced audit failure: 500, outbox row unchanged
 *  6. ticket merge with a forced audit failure: 500, tickets unchanged
 *
 * Cases 5-6 install a temporary trigger on admin_audit_logs in the test DB and
 * drop it afterwards.
 *
 *   DATABASE_URL=<local test db> npx tsx src/test-audit-transaction.live.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { AuditService } from "./services/AuditService";
import { registerTicketOpsRoutes } from "./api/routes/ticketOps";
import { registerDlqAdminRoutes } from "./api/routes/dlqAdmin";

{
  const db = new URL(process.env.DATABASE_URL || "");
  if (!["localhost", "127.0.0.1"].includes(db.hostname) || !db.pathname.includes("test")) {
    throw new Error(`Refusing to run: DATABASE_URL must be a local *test* database (got ${db.hostname}${db.pathname})`);
  }
}

const RUN = randomUUID().slice(0, 8);
const FAIL_ACTOR = `op-forcefail-${RUN}`;
const TOTAL = 6;
let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  console.log(`\n[Test] ${name}`);
  await fn();
  console.log("  ✓ PASS");
  passed++;
}
const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params)).rows;
const orgCount = async (id: string) => (await q(`SELECT count(*)::int n FROM organizations WHERE id = $1`, [id]))[0].n;

async function main() {
  const audit = new AuditService(pool as any);

  await test("1 success: business write and audit row (entity_type/entity_id) both persist", async () => {
    const orgId = `org-audit-ok-${RUN}`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $1, $1)`, [orgId]);
      const id = await audit.record(
        { projectId: null, action: "DLQ_REQUEUE", actor: "tester", entityType: "outbox_event", entityId: `probe-${RUN}`, newValue: { status: "pending" } },
        client as any
      );
      assert.ok(id, "audit row id returned");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    assert.equal(await orgCount(orgId), 1, "business write persisted");
    const rows = await q(`SELECT entity_type, entity_id FROM admin_audit_logs WHERE entity_id = $1`, [`probe-${RUN}`]);
    assert.deepEqual(rows, [{ entity_type: "outbox_event", entity_id: `probe-${RUN}` }], "audit row persisted");
  });

  await test("2 audit failure in a caller transaction: record() throws and the business write is rolled back", async () => {
    // Control: the pre-fix behaviour (failed statement swallowed, then COMMIT)
    // silently loses the write while the caller believes it succeeded.
    const lostOrg = `org-audit-lost-${RUN}`;
    const c1 = await pool.connect();
    try {
      await c1.query("BEGIN");
      await c1.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $1, $1)`, [lostOrg]);
      await c1.query(`INSERT INTO admin_audit_logs (action, actor) VALUES ('X', 'x')`).catch(() => {}); // entity_type NOT NULL
      const commit = await c1.query("COMMIT");
      assert.equal(commit.command, "ROLLBACK", "PostgreSQL turns COMMIT of an aborted transaction into ROLLBACK");
    } finally {
      c1.release();
    }
    assert.equal(await orgCount(lostOrg), 0, "control: write silently lost");

    // Fixed contract: the failure surfaces, the caller rolls back, nothing persists.
    const org = `org-audit-strict-${RUN}`;
    const c2 = await pool.connect();
    try {
      await c2.query("BEGIN");
      await c2.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $1, $1)`, [org]);
      await c2.query(`SET LOCAL search_path = pg_catalog`); // admin_audit_logs no longer resolvable
      await assert.rejects(
        audit.record({ projectId: null, action: "TICKET_MERGE", actor: "tester", entityType: "ticket", entityId: 1 }, c2 as any),
        /admin_audit_logs/
      );
      await c2.query("ROLLBACK");
    } finally {
      c2.release();
    }
    assert.equal(await orgCount(org), 0, "business write rolled back; no false success state");
  });

  // Seed a project with ticket pairs of the same customer for the route tests.
  const orgId = `org-audit-${RUN}`;
  await q(`INSERT INTO organizations (id, name, slug) VALUES ($1, $1, $1)`, [orgId]);
  const [p] = await q(`INSERT INTO projects (name, org_id, created_at) VALUES ($1, $2, NOW()) RETURNING id`, [`Audit Project ${RUN}`, orgId]);
  const projectId = Number(p.id);
  const [idn] = await q(`INSERT INTO identities (channel, channel_ref, org_id, created_at) VALUES ('webchat', $1, $2, NOW()) RETURNING id`, [`ref-${RUN}`, orgId]);
  const [conv] = await q(`INSERT INTO conversations (identity_id, project_id, org_id, channel, status, created_at, updated_at) VALUES ($1, $2, $3, 'webchat', 'open', NOW(), NOW()) RETURNING id`, [idn.id, projectId, orgId]);
  const mkTicket = async (n: string) =>
    (await q(`INSERT INTO tickets (subject, status, project_id, org_id, conversation_id, ticket_id, ticket_number, created_at, updated_at) VALUES ($1, 'OPEN', $2, $3, $4, $5, $5, NOW(), NOW()) RETURNING id`, [`Merge ${n}`, projectId, orgId, conv.id, `TCK-AUD-${RUN}-${n}`]))[0];
  const mkDeadLetter = async () =>
    (await q(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status, attempts, failure_kind, dead_lettered_at, created_at, updated_at)
       VALUES ('ticket', 'x', 'AuditProbe', $1::jsonb, 'dead_letter', 5, 'transient', NOW(), NOW(), NOW()) RETURNING id`,
      [JSON.stringify({ projectId })]
    ))[0];

  const app = Fastify();
  app.decorateRequest("tenantScope", null as any);
  app.decorateRequest("principal", null as any);
  app.addHook("preHandler", async (req: any) => {
    const who = String(req.headers["x-test-scope"] || "");
    const own = who === "own" || who === "forcefail";
    req.principal = { kind: "operator", subject: who === "forcefail" ? FAIL_ACTOR : `op-${who}`, role: "agent", orgId, projectIds: own ? [projectId] : [999999] };
    req.tenantScope = { unrestricted: false, orgId, projectIds: own ? [projectId] : [999999] };
  });
  await registerTicketOpsRoutes(app);
  await registerDlqAdminRoutes(app);
  await app.ready();

  await test("3 ticket merge route: merge, internal note and audit row committed", async () => {
    const src = await mkTicket("S");
    const dst = await mkTicket("T");
    const denied = await app.inject({ method: "POST", url: `/api/admin/tickets/${src.id}/merge`, headers: { "x-test-scope": "other" }, payload: { targetTicketId: dst.id } });
    assert.equal(denied.statusCode, 403, "other-project operator denied");

    const res = await app.inject({ method: "POST", url: `/api/admin/tickets/${src.id}/merge`, headers: { "x-test-scope": "own" }, payload: { targetTicketId: dst.id, reason: "same issue" } });
    assert.equal(res.statusCode, 200, res.body.slice(0, 300));
    const [s] = await q(`SELECT status, duplicate_of_ticket_id FROM tickets WHERE id = $1`, [src.id]);
    assert.deepEqual({ status: s.status, dup: Number(s.duplicate_of_ticket_id) }, { status: "RESOLVED", dup: Number(dst.id) }, "source merged into target");
    const [t] = await q(`SELECT status, duplicate_of_ticket_id FROM tickets WHERE id = $1`, [dst.id]);
    assert.deepEqual({ status: t.status, dup: t.duplicate_of_ticket_id }, { status: "OPEN", dup: null }, "target unchanged");
    assert.equal((await q(`SELECT count(*)::int n FROM internal_notes WHERE ticket_id = $1`, [dst.id]))[0].n, 1, "merge note committed");
    const auditRows = await q(`SELECT entity_type, entity_id FROM admin_audit_logs WHERE action = 'TICKET_MERGE' AND project_id = $1 AND entity_id = $2`, [projectId, String(src.id)]);
    assert.deepEqual(auditRows, [{ entity_type: "ticket", entity_id: String(src.id) }]);
  });

  await test("4 DLQ requeue route: outbox state changed, audit row exists, committed", async () => {
    const ev = await mkDeadLetter();
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/outbox/dead-letters/${ev.id}/requeue`, headers: { "x-test-scope": "other" } })).statusCode, 403);
    const res = await app.inject({ method: "POST", url: `/api/admin/outbox/dead-letters/${ev.id}/requeue`, headers: { "x-test-scope": "own" } });
    assert.equal(res.statusCode, 200, res.body.slice(0, 300));
    const [row] = await q(`SELECT status, attempts FROM outbox_events WHERE id = $1`, [ev.id]);
    assert.deepEqual({ status: row.status, attempts: Number(row.attempts) }, { status: "pending", attempts: 0 });
    const auditRows = await q(`SELECT entity_type, entity_id FROM admin_audit_logs WHERE action = 'DLQ_REQUEUE' AND entity_id = $1`, [String(ev.id)]);
    assert.deepEqual(auditRows, [{ entity_type: "outbox_event", entity_id: String(ev.id) }]);
    // Keep the probe out of any outbox processor.
    await q(`UPDATE outbox_events SET status = 'dead_letter' WHERE id = $1`, [ev.id]);
  });

  // Controlled audit failure for one actor only, test DB only.
  await q(`CREATE OR REPLACE FUNCTION audit_force_fail_${RUN}() RETURNS trigger LANGUAGE plpgsql AS $f$
            BEGIN IF NEW.actor = '${FAIL_ACTOR}' THEN RAISE EXCEPTION 'forced audit failure (test)'; END IF; RETURN NEW; END $f$`);
  await q(`CREATE TRIGGER audit_force_fail_${RUN} BEFORE INSERT ON admin_audit_logs FOR EACH ROW EXECUTE FUNCTION audit_force_fail_${RUN}()`);
  try {
    await test("5 DLQ requeue with a forced audit failure: error response, outbox row unchanged, no audit row", async () => {
      const ev = await mkDeadLetter();
      const res = await app.inject({ method: "POST", url: `/api/admin/outbox/dead-letters/${ev.id}/requeue`, headers: { "x-test-scope": "forcefail" } });
      assert.equal(res.statusCode, 500, `must not report success (got ${res.statusCode})`);
      const [row] = await q(`SELECT status, attempts FROM outbox_events WHERE id = $1`, [ev.id]);
      assert.deepEqual({ status: row.status, attempts: Number(row.attempts) }, { status: "dead_letter", attempts: 5 }, "requeue rolled back");
      assert.equal((await q(`SELECT count(*)::int n FROM admin_audit_logs WHERE entity_id = $1 AND action = 'DLQ_REQUEUE'`, [String(ev.id)]))[0].n, 0);
    });

    await test("6 ticket merge with a forced audit failure: error response, tickets and notes unchanged", async () => {
      const src = await mkTicket("FS");
      const dst = await mkTicket("FT");
      const res = await app.inject({ method: "POST", url: `/api/admin/tickets/${src.id}/merge`, headers: { "x-test-scope": "forcefail" }, payload: { targetTicketId: dst.id } });
      assert.equal(res.statusCode, 500, `must not report success (got ${res.statusCode})`);
      const [s] = await q(`SELECT status, duplicate_of_ticket_id FROM tickets WHERE id = $1`, [src.id]);
      assert.deepEqual({ status: s.status, dup: s.duplicate_of_ticket_id }, { status: "OPEN", dup: null }, "merge rolled back");
      assert.equal((await q(`SELECT count(*)::int n FROM internal_notes WHERE ticket_id = $1`, [dst.id]))[0].n, 0, "merge note rolled back");
    });
  } finally {
    await q(`DROP TRIGGER IF EXISTS audit_force_fail_${RUN} ON admin_audit_logs`);
    await q(`DROP FUNCTION IF EXISTS audit_force_fail_${RUN}()`);
  }

  await app.close();
}

main()
  .then(() => {
    console.log(`\n AUDIT TRANSACTION SUITE: ${passed}/${TOTAL} passed`);
    return pool.end().then(() => process.exit(passed === TOTAL ? 0 : 1));
  })
  .catch(async (err) => {
    console.error("\n✗ FAIL:", err?.stack || err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
