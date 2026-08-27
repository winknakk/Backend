import assert from "assert";
import { describe, it, before, after } from "node:test";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { pool } from "../../src/adapters/postgres/PostgresAdapter";
import { config } from "../../src/config/env";
import { executionContextService } from "../../src/domain/execution/ExecutionContextService";
import { SessionTokenService } from "../../src/infrastructure/security/SessionTokenService";

/**
 * POST /api/v1/internal/tickets/close — tenant scope and lifecycle status.
 *
 * Four defects this pins down, all found live:
 *
 *  1. The org filter was appended to the UPDATE only when the caller supplied
 *     an org, so OMITTING org_id matched by ticket number across every
 *     organization. Leaving a field out widened the scope instead of
 *     narrowing it.
 *  2. The UPDATE wrote status 'cancelled' in lowercase, which is not one of
 *     the eleven lifecycle statuses and fails tickets_status_lifecycle_check.
 *  3. The tool executed BEFORE the tenant check, through its own
 *     TransactionManager, so the handler's ROLLBACK could not undo it: a
 *     cross-tenant caller got a 404 while the ticket really had been closed.
 *  4. org_id was an agent-supplied input at all — B-0b. It is no longer part
 *     of the contract; the tenant is derived from the execution context.
 *
 * These assert the contract that replaced it. The route accepts either an
 * agent (execution context) or a console operator (session principal), and
 * neither supplies its own tenant.
 */

let server: any = null;
let ready = false;
let skipReason = "";

const contexts: string[] = [];
const ticketNumbers: string[] = [];

const A = { conversationId: 0, projectId: 1, orgId: "org_default" };
const B = { conversationId: 0, projectId: 101, orgId: "org_excise" };

describe("close_ticket — tenant scope is derived, never supplied (live)", () => {
  before(async () => {
    try {
      const a = await pool.query(
        `SELECT id FROM conversations WHERE project_id = 1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`
      );
      const b = await pool.query(
        `SELECT id FROM conversations WHERE project_id = 101 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`
      );
      if (!a.rows.length || !b.rows.length) {
        skipReason = "two live tenants are required";
        return;
      }
      A.conversationId = Number(a.rows[0].id);
      B.conversationId = Number(b.rows[0].id);

      const mod = await import("../../src/api/server");
      server = mod.fastify;
      await server.ready();
      mod.registerLocalTools();
      ready = true;
    } catch (err: any) {
      skipReason = err.message;
      console.error("[CloseScope] setup failed:", err.message);
      ready = false;
    }
  });

  after(async () => {
    if (ticketNumbers.length) {
      await pool
        .query(`DELETE FROM tickets WHERE ticket_number = ANY($1::varchar[])`, [ticketNumbers])
        .catch(() => {});
    }
    if (contexts.length) {
      await pool
        .query(`DELETE FROM execution_contexts WHERE context_id = ANY($1::varchar[])`, [contexts])
        .catch(() => {});
    }
    await pool.query(`DELETE FROM trace_events WHERE correlation_id LIKE 'closescope-%'`).catch(() => {});
    if (server) await server.close().catch(() => {});
    await pool.end().catch(() => {});
  });

  async function seed(tenant: typeof A, suffix: string): Promise<string> {
    const ticketNumber = `TCK-CLOSESCOPE-${Date.now()}-${suffix}`;
    await pool.query(
      `INSERT INTO tickets (ticket_number, ticket_id, conversation_id, project_id, org_id,
                            subject, summary, status, priority, severity)
       VALUES ($1, $1, $2, $3, $4, 'close scope probe', 'seeded by test', 'OPEN', 'P4', 'Low')`,
      [ticketNumber, tenant.conversationId, tenant.projectId, tenant.orgId]
    );
    ticketNumbers.push(ticketNumber);
    return ticketNumber;
  }

  async function mint(tenant: typeof A, label: string) {
    const r = await executionContextService.create({
      channel: "line",
      conversationId: tenant.conversationId,
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      correlationId: `closescope-${label}-${Date.now()}`,
    });
    contexts.push(r.context.contextId);
    return r;
  }

  function close(ticketNumber: string, token: string | null, extra: Record<string, unknown> = {}) {
    const headers: Record<string, string> = { Authorization: `Bearer ${config.API_KEY}` };
    if (token) headers["x-execution-context"] = token;
    return server.inject({
      method: "POST",
      url: "/api/v1/internal/tickets/close",
      headers,
      payload: {
        ticketId: ticketNumber,
        cancellation_reason: "closed by the tenant scope regression test",
        ...extra,
      },
    });
  }

  it("CLOSE-1: no execution context is refused — scope is never inferred from the body", async (t) => {
    if (!ready) return t.skip(skipReason);
    const ticketNumber = await seed(A, "noctx");

    // Previously the absence of an org widened the query. Now the absence of
    // an authority is simply refused.
    const res = await close(ticketNumber, null);
    assert.strictEqual(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`);
    assert.strictEqual(JSON.parse(res.body).code, "EXECUTION_CONTEXT_REQUIRED");

    const row = await pool.query(`SELECT status FROM tickets WHERE ticket_number = $1`, [ticketNumber]);
    assert.strictEqual(row.rows[0].status, "OPEN", "a refused close must not have touched the ticket");
  });

  it("CLOSE-2: a context for another tenant cannot close this ticket", async (t) => {
    if (!ready) return t.skip(skipReason);
    const ticketNumber = await seed(A, "othertenant");
    const { token } = await mint(B, "othertenant");

    const res = await close(ticketNumber, token);
    assert.strictEqual(res.statusCode, 404, `expected 404, got ${res.statusCode}: ${res.body}`);

    // The tool used to run before this check, on its own connection, so the
    // ticket was really closed even as a 404 came back.
    const row = await pool.query(`SELECT status FROM tickets WHERE ticket_number = $1`, [ticketNumber]);
    assert.strictEqual(row.rows[0].status, "OPEN", "a cross-tenant close must not have touched the ticket");
  });

  it("CLOSE-3: an agent-supplied org_id in the body is ignored", async (t) => {
    if (!ready) return t.skip(skipReason);
    const ticketNumber = await seed(A, "claimedorg");
    const { token } = await mint(A, "claimedorg");

    // org_id is no longer part of the contract. Sending it anyway must not
    // change which tenant the close acts for.
    const res = await close(ticketNumber, token, { org_id: B.orgId, project_id: B.projectId });
    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);

    const row = await pool.query(`SELECT status, org_id FROM tickets WHERE ticket_number = $1`, [ticketNumber]);
    assert.strictEqual(String(row.rows[0].org_id), A.orgId, "the claimed org must not have been applied");
    assert.strictEqual(row.rows[0].status, "CANCELLED");
  });

  // The console calls this route too. Requiring an execution context outright
  // would have locked operators out of closing tickets entirely, so the
  // operator path is verified rather than assumed.

  function operatorToken(projectIds: number[] | null) {
    const tokens = new SessionTokenService(config.SESSION_SECRET as string, config.SESSION_TTL_HOURS ?? 12);
    return tokens.issue({
      kind: "operator",
      subject: "9",
      email: "admin.good@ticketx.local",
      role: "admin",
      orgId: A.orgId,
      projectIds,
    } as any).token;
  }

  function closeAsOperator(ticketNumber: string, projectIds: number[] | null) {
    return server.inject({
      method: "POST",
      url: "/api/v1/internal/tickets/close",
      headers: { Authorization: `Bearer ${operatorToken(projectIds)}` },
      payload: { ticketId: ticketNumber, cancellation_reason: "closed from the admin console by an operator" },
    });
  }

  it("CLOSE-5: an operator scoped to the project can still close from the console", async (t) => {
    if (!ready) return t.skip(skipReason);
    const ticketNumber = await seed(A, "operator");

    const res = await closeAsOperator(ticketNumber, [A.projectId]);
    assert.strictEqual(res.statusCode, 200, `the console must not be locked out: ${res.statusCode} ${res.body}`);

    const row = await pool.query(`SELECT status FROM tickets WHERE ticket_number = $1`, [ticketNumber]);
    assert.strictEqual(row.rows[0].status, "CANCELLED");
  });

  it("CLOSE-6: an operator outside the project is refused", async (t) => {
    if (!ready) return t.skip(skipReason);
    const ticketNumber = await seed(A, "operator-oos");

    const res = await closeAsOperator(ticketNumber, [B.projectId]);
    assert.strictEqual(res.statusCode, 404, `expected 404, got ${res.statusCode}: ${res.body}`);

    const row = await pool.query(`SELECT status FROM tickets WHERE ticket_number = $1`, [ticketNumber]);
    assert.strictEqual(row.rows[0].status, "OPEN", "an out-of-scope operator must not have closed it");
  });

  it("CLOSE-4: the owning context closes it, and the lifecycle status is valid", async (t) => {
    if (!ready) return t.skip(skipReason);
    const ticketNumber = await seed(A, "owner");
    const { token } = await mint(A, "owner");

    const res = await close(ticketNumber, token);
    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);

    const row = await pool.query(`SELECT status, cancellation_reason FROM tickets WHERE ticket_number = $1`, [
      ticketNumber,
    ]);
    // Uppercase: lowercase 'cancelled' fails tickets_status_lifecycle_check,
    // so a successful write is itself proof the constraint was satisfied.
    assert.strictEqual(row.rows[0].status, "CANCELLED", "the lifecycle status must be one the constraint allows");
    assert.ok(row.rows[0].cancellation_reason, "the reason must be recorded");
  });
});
