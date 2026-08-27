import assert from "assert";
import { describe, it, before, after } from "node:test";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { pool } from "../../src/adapters/postgres/PostgresAdapter";
import { config } from "../../src/config/env";

/**
 * POST /api/v1/internal/tickets/close — tenant scope and lifecycle status.
 *
 * Two defects this pins down, both found while auditing the internal callers
 * for B-0:
 *
 *  1. The org filter was appended to the UPDATE only when the caller supplied
 *     an org. A caller that simply OMITTED org_id therefore matched by ticket
 *     number across every organization. Leaving a field out widened the scope
 *     instead of narrowing it.
 *  2. The UPDATE wrote status 'cancelled' in lowercase, which is not one of
 *     the eleven lifecycle statuses and fails tickets_status_lifecycle_check,
 *     so the close errored at the write.
 */

let server: any = null;
let ready = false;
let conversationId = 0;
const ticketNumbers: string[] = [];

const OWNER_ORG = "org_default";
const OTHER_ORG = "org_excise";

describe("close_ticket — tenant scope is mandatory (live)", () => {
  before(async () => {
    try {
      const c = await pool.query(
        `SELECT id FROM conversations WHERE project_id = 1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`
      );
      if (!c.rows.length) return;
      conversationId = Number(c.rows[0].id);

      const mod = await import("../../src/api/server");
      server = mod.fastify;
      await server.ready();

      // bootstrap() populates the tool registry, but it also starts the
      // BullMQ worker, which needs Redis. Registering the single tool this
      // route resolves keeps the route itself the real one.
      const { CloseTicketTool } = await import("../../src/tools/ToolRegistry");
      if (!mod.toolRegistry.getLocalTool("close_ticket")) {
        mod.toolRegistry.registerTool(new CloseTicketTool());
      }
      ready = true;
    } catch (err: any) {
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
    if (server) await server.close().catch(() => {});
    await pool.end().catch(() => {});
  });

  function auth() {
    return { Authorization: `Bearer ${config.API_KEY}` };
  }

  /** A ticket owned by OWNER_ORG, created directly so the test controls the tenant. */
  async function seed(suffix: string): Promise<string> {
    const ticketNumber = `TCK-CLOSESCOPE-${Date.now()}-${suffix}`;
    await pool.query(
      `INSERT INTO tickets (ticket_number, ticket_id, conversation_id, project_id, org_id, subject, summary, status, priority, severity)
       VALUES ($1, $1, $2, 1, $3, 'close scope probe', 'seeded by test', 'OPEN', 'P4', 'Low')`,
      [ticketNumber, conversationId, OWNER_ORG]
    );
    ticketNumbers.push(ticketNumber);
    return ticketNumber;
  }

  async function close(ticketNumber: string, orgId: string | null) {
    const payload: Record<string, unknown> = {
      ticketId: ticketNumber,
      cancellation_reason: "closed by the tenant scope regression test",
    };
    if (orgId !== null) payload.org_id = orgId;
    return server.inject({
      method: "POST",
      url: "/api/v1/internal/tickets/close",
      headers: auth(),
      payload,
    });
  }

  it("CLOSE-1: omitting org_id is refused, not treated as unscoped", async (t) => {
    if (!ready) return t.skip("live server unavailable");
    const ticketNumber = await seed("noorg");

    const res = await close(ticketNumber, null);
    assert.strictEqual(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    assert.strictEqual(JSON.parse(res.body).code, "ORG_SCOPE_REQUIRED");

    const row = await pool.query(`SELECT status FROM tickets WHERE ticket_number = $1`, [ticketNumber]);
    assert.strictEqual(row.rows[0].status, "OPEN", "a refused close must not have touched the ticket");
  });

  it("CLOSE-2: another tenant's org cannot close this ticket", async (t) => {
    if (!ready) return t.skip("live server unavailable");
    const ticketNumber = await seed("otherorg");

    const res = await close(ticketNumber, OTHER_ORG);
    assert.strictEqual(res.statusCode, 404, `expected 404, got ${res.statusCode}: ${res.body}`);

    const row = await pool.query(`SELECT status FROM tickets WHERE ticket_number = $1`, [ticketNumber]);
    assert.strictEqual(row.rows[0].status, "OPEN", "a cross-tenant close must not have touched the ticket");
  });

  it("CLOSE-3: the owning org closes it, and the lifecycle status is valid", async (t) => {
    if (!ready) return t.skip("live server unavailable");
    const ticketNumber = await seed("owner");

    const res = await close(ticketNumber, OWNER_ORG);
    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);

    const row = await pool.query(`SELECT status, cancellation_reason FROM tickets WHERE ticket_number = $1`, [
      ticketNumber,
    ]);
    // Uppercase: lowercase 'cancelled' fails tickets_status_lifecycle_check,
    // so a successful write is itself the proof the constraint was satisfied.
    assert.strictEqual(row.rows[0].status, "CANCELLED", "the lifecycle status must be one the constraint allows");
    assert.ok(row.rows[0].cancellation_reason, "the reason must be recorded");
  });
});
