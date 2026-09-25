/**
 * AuditService transaction safety — live test against an ISOLATED database.
 *
 * Refuses to run unless DATABASE_URL is a local database whose name contains
 * "test". Verifies, on real PostgreSQL:
 *  1. an audit write inside a caller transaction populates entity_type /
 *     entity_id and the caller's write commits;
 *  2. a failing audit write cannot roll back the caller's transaction
 *     (savepoint), with a control case reproducing the original defect;
 *  3. POST /api/admin/tickets/:id/merge persists the merge and its audit row;
 *  4. POST /api/admin/outbox/dead-letters/:id/requeue persists and is audited.
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
let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  console.log(`\n[Test] ${name}`);
  await fn();
  console.log("  ✓ PASS");
  passed++;
}
const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params)).rows;

async function main() {
  const audit = new AuditService(pool as any);

  await test("1 audit inside a committed caller transaction: caller write persists, entity columns populated", async () => {
    const orgId = `org-audit-ok-${RUN}`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $1, $1)`, [orgId]);
      const id = await audit.record({ projectId: null, action: "DLQ_REQUEUE", actor: "tester", oldValue: { id: 900001 }, newValue: { id: 900001, status: "pending" } }, client as any);
      assert.ok(id, "audit row id returned");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    assert.equal((await q(`SELECT count(*)::int n FROM organizations WHERE id = $1`, [orgId]))[0].n, 1);
    const [row] = await q(`SELECT entity_type, entity_id, action FROM admin_audit_logs WHERE action = 'DLQ_REQUEUE' AND entity_id = '900001' ORDER BY id DESC LIMIT 1`);
    assert.deepEqual(row, { entity_type: "dlq", entity_id: "900001", action: "DLQ_REQUEUE" });
  });

  await test("2 failing audit write cannot roll back the caller transaction (control reproduces the old defect)", async () => {
    // Control: the pre-fix behaviour — a failed statement inside the
    // transaction, error swallowed, then COMMIT — silently loses the write.
    const lostOrg = `org-audit-lost-${RUN}`;
    const c1 = await pool.connect();
    try {
      await c1.query("BEGIN");
      await c1.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $1, $1)`, [lostOrg]);
      await c1.query(`INSERT INTO admin_audit_logs (action, actor) VALUES ('X', 'x')`).catch(() => {}); // entity_type NOT NULL -> fails
      const commit = await c1.query("COMMIT");
      assert.equal(commit.command, "ROLLBACK", "PostgreSQL turns COMMIT of an aborted transaction into ROLLBACK");
    } finally {
      c1.release();
    }
    assert.equal((await q(`SELECT count(*)::int n FROM organizations WHERE id = $1`, [lostOrg]))[0].n, 0, "control: write lost");

    // Fixed path: force the audit insert to fail inside the caller's transaction.
    const keptOrg = `org-audit-kept-${RUN}`;
    const c2 = await pool.connect();
    try {
      await c2.query("BEGIN");
      await c2.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $1, $1)`, [keptOrg]);
      await c2.query(`SET LOCAL search_path = pg_catalog`); // admin_audit_logs no longer resolvable
      const id = await audit.record({ projectId: null, action: "TICKET_MERGE", actor: "tester", oldValue: { sourceTicketId: 1 } }, c2 as any);
      assert.equal(id, null, "audit failure is reported as null");
      const commit = await c2.query("COMMIT");
      assert.equal(commit.command, "COMMIT", "caller transaction still commits");
    } finally {
      c2.release();
    }
    assert.equal((await q(`SELECT count(*)::int n FROM organizations WHERE id = $1`, [keptOrg]))[0].n, 1, "caller write persisted");
  });

  // Seed a project with two tickets of the same customer for the route tests.
  const orgId = `org-audit-${RUN}`;
  await q(`INSERT INTO organizations (id, name, slug) VALUES ($1, $1, $1)`, [orgId]);
  const [p] = await q(`INSERT INTO projects (name, org_id, created_at) VALUES ($1, $2, NOW()) RETURNING id`, [`Audit Project ${RUN}`, orgId]);
  const projectId = Number(p.id);
  const [idn] = await q(`INSERT INTO identities (channel, channel_ref, org_id, created_at) VALUES ('webchat', $1, $2, NOW()) RETURNING id`, [`ref-${RUN}`, orgId]);
  const [conv] = await q(`INSERT INTO conversations (identity_id, project_id, org_id, channel, status, created_at, updated_at) VALUES ($1, $2, $3, 'webchat', 'open', NOW(), NOW()) RETURNING id`, [idn.id, projectId, orgId]);
  const mkTicket = async (n: string) =>
    (await q(`INSERT INTO tickets (subject, status, project_id, org_id, conversation_id, ticket_id, ticket_number, created_at, updated_at) VALUES ($1, 'OPEN', $2, $3, $4, $5, $5, NOW(), NOW()) RETURNING id`, [`Merge ${n}`, projectId, orgId, conv.id, `TCK-AUD-${RUN}-${n}`]))[0];
  const src = await mkTicket("S");
  const dst = await mkTicket("T");

  const app = Fastify();
  app.decorateRequest("tenantScope", null as any);
  app.decorateRequest("principal", null as any);
  app.addHook("preHandler", async (req: any) => {
    const who = req.headers["x-test-scope"];
    req.principal = { kind: "operator", subject: `op-${who}`, role: "agent", orgId, projectIds: who === "own" ? [projectId] : [999999] };
    req.tenantScope = { unrestricted: false, orgId, projectIds: who === "own" ? [projectId] : [999999] };
  });
  await registerTicketOpsRoutes(app);
  await registerDlqAdminRoutes(app);
  await app.ready();

  await test("3 ticket merge through the real route persists the merge and its audit row", async () => {
    const denied = await app.inject({ method: "POST", url: `/api/admin/tickets/${src.id}/merge`, headers: { "x-test-scope": "other" }, payload: { targetTicketId: dst.id } });
    assert.equal(denied.statusCode, 403, "other-project operator denied");

    const res = await app.inject({ method: "POST", url: `/api/admin/tickets/${src.id}/merge`, headers: { "x-test-scope": "own" }, payload: { targetTicketId: dst.id, reason: "same issue" } });
    assert.equal(res.statusCode, 200, res.body.slice(0, 300));
    const [row] = await q(`SELECT duplicate_of_ticket_id FROM tickets WHERE id = $1`, [src.id]);
    assert.equal(Number(row.duplicate_of_ticket_id), Number(dst.id), "merge persisted (previously rolled back while answering 200)");
    const auditRows = await q(`SELECT entity_type, entity_id, project_id FROM admin_audit_logs WHERE action = 'TICKET_MERGE' AND project_id = $1`, [projectId]);
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].entity_type, "ticket");
    assert.equal(auditRows[0].entity_id, String(src.id));
  });

  await test("4 DLQ requeue through the real route persists and is audited", async () => {
    const [ev] = await q(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status, attempts, failure_kind, dead_lettered_at, created_at, updated_at)
       VALUES ('ticket', 'x', 'AuditProbe', $1::jsonb, 'dead_letter', 5, 'transient', NOW(), NOW(), NOW()) RETURNING id`,
      [JSON.stringify({ projectId })]
    );
    const denied = await app.inject({ method: "POST", url: `/api/admin/outbox/dead-letters/${ev.id}/requeue`, headers: { "x-test-scope": "other" } });
    assert.equal(denied.statusCode, 403);
    const res = await app.inject({ method: "POST", url: `/api/admin/outbox/dead-letters/${ev.id}/requeue`, headers: { "x-test-scope": "own" } });
    assert.equal(res.statusCode, 200, res.body.slice(0, 300));
    const [row] = await q(`SELECT status, attempts FROM outbox_events WHERE id = $1`, [ev.id]);
    assert.deepEqual({ status: row.status, attempts: Number(row.attempts) }, { status: "pending", attempts: 0 });
    // Leave it dead-lettered again so no processor ever dispatches the probe.
    await q(`UPDATE outbox_events SET status = 'dead_letter' WHERE id = $1`, [ev.id]);
    const auditRows = await q(`SELECT entity_type, entity_id FROM admin_audit_logs WHERE action = 'DLQ_REQUEUE' AND entity_id = $1`, [String(ev.id)]);
    assert.deepEqual(auditRows, [{ entity_type: "dlq", entity_id: String(ev.id) }]);
  });

  await app.close();
}

main()
  .then(() => {
    console.log(`\n AUDIT TRANSACTION SUITE: ${passed}/4 passed`);
    return pool.end().then(() => process.exit(passed === 4 ? 0 : 1));
  })
  .catch(async (err) => {
    console.error("\n✗ FAIL:", err?.stack || err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
