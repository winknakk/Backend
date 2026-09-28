/**
 * Flow 5 / Flow 6 ownership invariants — live test against an ISOLATED database.
 *
 * active_ticket_id is only a ticket-focus pointer. Switching it (portal
 * switch-ticket, the Flow 6 path) or cancelling a ticket (Flow 5) must never
 * change conversation.project_id, the customer identity, tenant ownership or
 * authorization scope, and a ticket of another project must be rejected.
 *
 * Drives the real routes (registerPortalRoutes switch-ticket / transition with
 * a real customer JWT, registerTicketOpsRoutes for operator scope) against the
 * test DB. Refuses to run unless DATABASE_URL is a local database whose name
 * contains "test".
 *
 *   DATABASE_URL=<local test db> npx tsx src/test-flow56-ownership-invariants.live.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { pool, PostgresAdapter } from "./adapters/postgres/PostgresAdapter";
import { registerPortalRoutes } from "./api/routes/portal";
import { registerTicketOpsRoutes } from "./api/routes/ticketOps";
import { JwtUtil } from "./shared/jwt";
import { getWebchatJwtSecret } from "./middleware/customerAuth";

{
  const db = new URL(process.env.DATABASE_URL || "");
  if (!["localhost", "127.0.0.1"].includes(db.hostname) || !db.pathname.includes("test")) {
    throw new Error(`Refusing to run: DATABASE_URL must be a local *test* database (got ${db.hostname}${db.pathname})`);
  }
}

const RUN = randomUUID().slice(0, 8);
const TOTAL = 5;
let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  console.log(`\n[Test] ${name}`);
  await fn();
  console.log("  ✓ PASS");
  passed++;
}
const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params)).rows;

async function main() {
  // --- seed: one customer (profile + identity) with conversations in P1 and P2
  const orgId = `org-f56-${RUN}`;
  await q(`INSERT INTO organizations (id, name, slug) VALUES ($1, $1, $1)`, [orgId]);
  const mkProject = async (n: string) =>
    Number((await q(`INSERT INTO projects (name, org_id, created_at) VALUES ($1, $2, NOW()) RETURNING id`, [`F56 ${n} ${RUN}`, orgId]))[0].id);
  const P1 = await mkProject("P1");
  const P2 = await mkProject("P2");

  const [{ data_type }] = await q(`SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'profiles' AND column_name = 'id'`);
  const profileId = /int/.test(data_type) ? String(Math.floor(Date.now() % 2000000000)) : `prof-${RUN}`;
  await q(`INSERT INTO profiles (id, name, created_at) VALUES ($1, $2, NOW())`, [profileId, `Customer ${RUN}`]);
  const [idn] = await q(`INSERT INTO identities (channel, channel_ref, org_id, profile_id, created_at) VALUES ('webchat', $1, $2, $3, NOW()) RETURNING id`, [`ref-f56-${RUN}`, orgId, profileId]);
  const identityId = Number(idn.id);

  const mkConv = async (projectId: number) =>
    Number((await q(`INSERT INTO conversations (identity_id, project_id, org_id, channel, status, created_at, updated_at) VALUES ($1, $2, $3, 'webchat', 'open', NOW(), NOW()) RETURNING id`, [identityId, projectId, orgId]))[0].id);
  const C1 = await mkConv(P1);
  const C2 = await mkConv(P2);
  const mkTicket = async (projectId: number, convId: number, n: string) =>
    Number((await q(`INSERT INTO tickets (subject, status, project_id, org_id, conversation_id, ticket_id, ticket_number, created_at, updated_at) VALUES ($1, 'OPEN', $2, $3, $4, $5, $5, NOW(), NOW()) RETURNING id`, [`F56 ${n}`, projectId, orgId, convId, `TCK-F56-${RUN}-${n}`]))[0].id);
  const T1 = await mkTicket(P1, C1, "T1");
  const T2 = await mkTicket(P1, C1, "T2");
  const T3 = await mkTicket(P2, C2, "T3"); // same customer, other project
  await q(`UPDATE conversations SET active_ticket_id = $1 WHERE id = $2`, [T1, C1]);

  const snapshot = async (convId: number) =>
    (await q(`SELECT project_id, identity_id, org_id, active_ticket_id FROM conversations WHERE id = $1`, [convId]))[0];
  const before = await snapshot(C1);

  const customerToken = (projectId: number) =>
    JwtUtil.sign({ role: "customer", identityId, profileId, projectId, kind: "customer" }, getWebchatJwtSecret(), 600);

  const app = Fastify();
  app.decorateRequest("principal", null as any);
  app.decorateRequest("tenantScope", null as any);
  app.decorateRequest("tenantContext", null as any);
  // Operator scope for the ticket-ops route: server-side, never from headers.
  app.addHook("preHandler", async (req: any) => {
    if (String(req.url).startsWith("/api/admin/")) {
      req.principal = { kind: "operator", subject: `op-p1-${RUN}`, role: "agent", orgId, projectIds: [P1] };
      req.tenantScope = { unrestricted: false, orgId, projectIds: [P1] };
    }
  });
  registerPortalRoutes(app, { dbAdapter: new PostgresAdapter() as any, slaService: {} as any });
  await registerTicketOpsRoutes(app);
  await app.ready();
  const switchTo = (ticketId: number | string, projectId: number, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/api/portal/switch-ticket", headers: { authorization: `Bearer ${customerToken(projectId)}`, ...headers }, payload: { ticketId } });

  await test("A switching active ticket T1 -> T2 keeps conversation.project_id = P1", async () => {
    const res = await switchTo(T2, P1);
    assert.equal(res.statusCode, 200, res.body.slice(0, 200));
    assert.equal(JSON.parse(res.body).projectId, P1);
    const after = await snapshot(C1);
    assert.equal(Number(after.active_ticket_id), T2, "focus moved");
    assert.equal(Number(after.project_id), P1, "project unchanged");
    assert.equal(Number(after.project_id), Number(before.project_id));
  });

  await test("B a ticket of P2 is rejected for a P1 principal (customer and operator), forged headers ignored", async () => {
    const cust = await switchTo(T3, P1, { "x-project-id": String(P2), "x-org-id": orgId });
    assert.ok([403, 404].includes(cust.statusCode), `customer cross-project switch must be rejected (got ${cust.statusCode})`);
    assert.equal(Number((await snapshot(C1)).active_ticket_id), T2, "focus not moved to the P2 ticket");
    assert.equal(Number((await snapshot(C1)).project_id), P1);

    const op = await app.inject({ method: "POST", url: `/api/admin/tickets/${T3}/merge`, headers: { "x-project-id": String(P2) }, payload: { targetTicketId: T2 } });
    assert.equal(op.statusCode, 403, "P1 operator cannot operate on a P2 ticket");
    const [t3] = await q(`SELECT project_id, duplicate_of_ticket_id FROM tickets WHERE id = $1`, [T3]);
    assert.deepEqual({ p: Number(t3.project_id), dup: t3.duplicate_of_ticket_id }, { p: P2, dup: null });
  });

  await test("C customer identity and tenant ownership unchanged after switching", async () => {
    const after = await snapshot(C1);
    assert.equal(Number(after.identity_id), identityId);
    assert.equal(after.org_id, before.org_id);
    const c2 = await snapshot(C2);
    assert.deepEqual({ p: Number(c2.project_id), i: Number(c2.identity_id) }, { p: P2, i: identityId }, "the P2 conversation is untouched");
    const tickets = await q(`SELECT id, project_id, conversation_id FROM tickets WHERE id = ANY($1::int[]) ORDER BY id`, [[T1, T2, T3]]);
    assert.deepEqual(tickets.map((t: any) => [Number(t.project_id), Number(t.conversation_id)]), [[P1, C1], [P1, C1], [P2, C2]]);
  });

  await test("D authorization scope unchanged after switching: still only P1 tickets, P2 still refused", async () => {
    const list = await app.inject({ method: "GET", url: "/api/portal/tickets", headers: { authorization: `Bearer ${customerToken(P1)}` } });
    assert.equal(list.statusCode, 200, list.body.slice(0, 200));
    const body = JSON.parse(list.body);
    const rows: any[] = Array.isArray(body) ? body : body.tickets || body.data || [];
    const ids = rows.map((t: any) => Number(t.id));
    assert.ok(ids.includes(T1) && ids.includes(T2), "own P1 tickets visible");
    assert.ok(!ids.includes(T3), "P2 ticket not visible to the P1 principal");
    const again = await switchTo(T3, P1);
    assert.ok([403, 404].includes(again.statusCode), "still refused after a successful switch");
  });

  await test("E cancelling a ticket (Flow 5) does not change project, tenant or customer ownership", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/portal/tickets/${T2}/transition`,
      headers: { authorization: `Bearer ${customerToken(P1)}` },
      payload: { targetStatus: "CANCELLED", reason: "invariant test" },
    });
    const [t2] = await q(`SELECT status, project_id, org_id, conversation_id FROM tickets WHERE id = $1`, [T2]);
    console.log(`    transition -> HTTP ${res.statusCode}, status now ${t2.status}`);
    assert.ok(res.statusCode < 500, `transition must not error (got ${res.statusCode}: ${res.body.slice(0, 160)})`);
    assert.deepEqual({ p: Number(t2.project_id), o: t2.org_id, c: Number(t2.conversation_id) }, { p: P1, o: orgId, c: C1 }, "ticket ownership unchanged");
    const after = await snapshot(C1);
    assert.deepEqual({ p: Number(after.project_id), i: Number(after.identity_id), o: after.org_id }, { p: P1, i: identityId, o: before.org_id }, "conversation ownership unchanged");
  });

  await app.close();
}

main()
  .then(() => {
    console.log(`\n FLOW 5/6 OWNERSHIP INVARIANTS: ${passed}/${TOTAL} passed`);
    return pool.end().then(() => process.exit(passed === TOTAL ? 0 : 1));
  })
  .catch(async (err) => {
    console.error("\n✗ FAIL:", err?.stack || err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
