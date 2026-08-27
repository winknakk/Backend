import assert from "assert";
import { describe, it, before, after } from "node:test";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { pool } from "../../src/adapters/postgres/PostgresAdapter";
import { config } from "../../src/config/env";
import { executionContextService } from "../../src/domain/execution/ExecutionContextService";
import { traceRecorder } from "../../src/observability/TraceRecorder";

/**
 * B-5 — the causal chain, exercised through the real HTTP routes.
 *
 * These go through fastify.inject rather than calling the services directly,
 * so the guard, the handler, the ticket binding and the chain query are the
 * ones that run in production.
 *
 * What this does NOT prove: that PromptX or AgentX executed. Those components
 * are not reachable from here, and no substitute is injected to make the
 * chain look complete. The final assertion is the opposite one — that the
 * chain REPORTS those hops as missing. A chain claiming to be whole without
 * them would be the defect, not the evidence.
 */

let server: any = null;
let ready = false;
let conversationId = 0;
let projectId = 0;
let orgId = "";
const contexts: string[] = [];
const correlations: string[] = [];
const ticketIds: number[] = [];

const REJECTED_SUBJECT = "B5 rejected probe";

describe("B-5 — causal chain through the real routes", () => {
  before(async () => {
    try {
      const c = await pool.query(
        `SELECT id, project_id, org_id FROM conversations
          WHERE project_id = 1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`
      );
      if (!c.rows.length) return;
      conversationId = Number(c.rows[0].id);
      projectId = Number(c.rows[0].project_id);
      orgId = String(c.rows[0].org_id || "org_default");

      // ready() only, not bootstrap(): routes, hooks and plugins register at
      // module scope, while bootstrap() additionally starts the BullMQ worker
      // and config watcher, which need Redis. The routes under test are the
      // real ones either way.
      const mod = await import("../../src/api/server");
      server = mod.fastify;
      await server.ready();
      ready = true;
    } catch (err: any) {
      console.error("[TraceChain] setup failed:", err.message);
      ready = false;
    }
  });

  after(async () => {
    if (ticketIds.length) {
      await pool.query(`DELETE FROM trace_events WHERE ticket_id = ANY($1::int[])`, [ticketIds]).catch(() => {});
      await pool.query(`DELETE FROM tickets WHERE id = ANY($1::int[])`, [ticketIds]).catch(() => {});
    }
    if (correlations.length) {
      await pool
        .query(`DELETE FROM trace_events WHERE correlation_id = ANY($1::varchar[])`, [correlations])
        .catch(() => {});
    }
    if (contexts.length) {
      await pool
        .query(`DELETE FROM execution_contexts WHERE context_id = ANY($1::varchar[])`, [contexts])
        .catch(() => {});
    }
    if (server) await server.close().catch(() => {});
    await pool.end().catch(() => {});
  });

  function auth() {
    return { Authorization: `Bearer ${config.API_KEY}` };
  }

  async function mint(correlationId: string) {
    const r = await executionContextService.create({
      channel: "line",
      lineEventId: `${correlationId}-evt`,
      conversationId,
      projectId,
      orgId,
      correlationId,
    });
    contexts.push(r.context.contextId);
    correlations.push(correlationId);
    return r;
  }

  it("B5-1: a ticket created through the guarded route is bound to its execution context", async (t) => {
    if (!ready) return t.skip("live server or tenant unavailable");
    const correlationId = `b5-test-${Date.now()}-bind`;
    const { token, context } = await mint(correlationId);

    // The hop that precedes the agent, recorded by the webhook in production.
    await traceRecorder.record({
      correlationId,
      component: "line_webhook",
      eventType: "message_received",
      lineEventId: context.lineEventId,
      conversationId,
      projectId,
      orgId,
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/internal/tickets",
      headers: { ...auth(), "x-execution-context": token },
      payload: {
        conversationId,
        subject: "B5 chain probe",
        summary: "trace binding",
        severity: "Low",
        priority: "P4",
      },
    });

    assert.strictEqual(res.statusCode, 200, res.body);
    const ticketNumber = JSON.parse(res.body).ticketId;
    assert.ok(ticketNumber, `the route must return a ticket number; got ${res.body}`);

    const row = await pool.query(
      `SELECT id, execution_context_id, correlation_id FROM tickets WHERE ticket_id = $1`,
      [ticketNumber]
    );
    assert.strictEqual(row.rows.length, 1, "ticket row must exist");
    ticketIds.push(Number(row.rows[0].id));

    assert.strictEqual(
      row.rows[0].execution_context_id,
      context.contextId,
      "ticket must name its execution context"
    );
    assert.strictEqual(row.rows[0].correlation_id, correlationId, "ticket must carry the turn's correlation id");
  });

  it("B5-2: the chain walks a ticket back to the LINE event", async (t) => {
    if (!ready) return t.skip("live server or tenant unavailable");
    assert.ok(ticketIds.length, "B5-1 must have produced a ticket");
    const chain = await traceRecorder.chainForTicket(ticketIds[0]);

    assert.ok(chain.correlationId, "the ticket must have a correlation id to walk");
    const components = chain.events.map((e: any) => e.component);
    assert.ok(components.includes("line_webhook"), `chain is missing the inbound hop: ${components}`);
    assert.ok(components.includes("ticketx"), `chain is missing ticket creation: ${components}`);

    const inbound = chain.events.find((e: any) => e.component === "line_webhook");
    assert.strictEqual(Number(inbound.conversation_id), conversationId);
    assert.ok(inbound.line_event_id, "the LINE event id must be carried, not dropped");

    // Ordering is causal: the message arrives before the ticket exists.
    const iIn = components.indexOf("line_webhook");
    const iTicket = components.indexOf("ticketx");
    assert.ok(iIn < iTicket, "the inbound event must precede ticket creation");
  });

  it("B5-3: hops that did not happen are reported missing, not implied", async (t) => {
    if (!ready) return t.skip("live server or tenant unavailable");
    // Without a real ticket this would assert against an empty chain and pass
    // for the wrong reason.
    assert.ok(ticketIds.length, "B5-1 must have produced a ticket");
    const chain = await traceRecorder.chainForTicket(ticketIds[0]);
    // PromptX and AgentX were not reachable from this test and nothing stood
    // in for them. The chain must say so rather than read as complete.
    for (const absent of ["promptx", "agentx_gate", "agentx_support"]) {
      assert.ok(
        chain.missingLinks.includes(absent),
        `${absent} did not run, so it must appear in missingLinks: ${JSON.stringify(chain.missingLinks)}`
      );
    }
  });

  it("B5-4: the chain is queryable over HTTP and requires authentication", async (t) => {
    if (!ready) return t.skip("live server or tenant unavailable");
    assert.ok(ticketIds.length, "B5-1 must have produced a ticket");
    const res = await server.inject({
      method: "GET",
      url: `/api/v1/tickets/${ticketIds[0]}/trace`,
      headers: auth(),
    });
    assert.strictEqual(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ticketId, ticketIds[0]);
    assert.ok(Array.isArray(body.events) && body.events.length >= 2, "the chain must be returned in full");
    assert.ok(Array.isArray(body.missingLinks), "missingLinks must be reported to the caller");

    const unauth = await server.inject({ method: "GET", url: `/api/v1/tickets/${ticketIds[0]}/trace` });
    assert.ok(
      unauth.statusCode === 401 || unauth.statusCode === 403,
      `unauthenticated read returned ${unauth.statusCode}`
    );
  });

  it("B5-5: no execution context, no ticket — over real HTTP", async (t) => {
    if (!ready) return t.skip("live server or tenant unavailable");
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/internal/tickets",
      headers: auth(),
      payload: {
        conversationId,
        subject: REJECTED_SUBJECT,
        summary: "no context supplied",
        severity: "Low",
        priority: "P4",
      },
    });
    assert.strictEqual(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`);
    assert.strictEqual(JSON.parse(res.body).code, "EXECUTION_CONTEXT_REQUIRED");

    const leaked = await pool.query(`SELECT id FROM tickets WHERE subject = $1`, [REJECTED_SUBJECT]);
    assert.strictEqual(leaked.rows.length, 0, "a rejected call must not have created a ticket");
  });

  it("B5-6: tenant fields in the request body are discarded end to end", async (t) => {
    if (!ready) return t.skip("live server or tenant unavailable");
    const correlationId = `b5-test-${Date.now()}-claim`;
    const { token } = await mint(correlationId);

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/internal/tickets",
      headers: { ...auth(), "x-execution-context": token },
      payload: {
        conversationId: 999999,
        project_id: 101,
        org_id: "org_excise",
        subject: "B5 claimed tenant",
        summary: "the body names another tenant",
        severity: "Low",
        priority: "P4",
      },
    });

    assert.strictEqual(res.statusCode, 200, res.body);
    const ticketNumber = JSON.parse(res.body).ticketId;
    const row = await pool.query(
      `SELECT id, conversation_id, project_id, org_id FROM tickets WHERE ticket_id = $1`,
      [ticketNumber]
    );
    assert.strictEqual(row.rows.length, 1);
    ticketIds.push(Number(row.rows[0].id));

    assert.strictEqual(Number(row.rows[0].conversation_id), conversationId, "the claimed conversation is ignored");
    assert.strictEqual(Number(row.rows[0].project_id), projectId, "the claimed project is ignored");
    assert.strictEqual(String(row.rows[0].org_id), orgId, "the claimed org is ignored");

    // The attempt itself must be visible afterwards.
    const attempts = await pool.query(
      `SELECT detail FROM trace_events WHERE correlation_id = $1 AND event_type = 'forbidden_fields_ignored'`,
      [correlationId]
    );
    assert.ok(attempts.rows.length >= 1, "the attempt must be recorded in the trace");
    const fields = attempts.rows[0].detail?.attemptedFields || [];
    assert.ok(fields.includes("org_id") && fields.includes("project_id"), `recorded: ${JSON.stringify(fields)}`);
  });
});
