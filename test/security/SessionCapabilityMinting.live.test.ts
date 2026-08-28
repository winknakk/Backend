import assert from "assert";
import { describe, it, before, after } from "node:test";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { pool } from "../../src/adapters/postgres/PostgresAdapter";
import { config } from "../../src/config/env";
import { executionContextService } from "../../src/domain/execution/ExecutionContextService";

/**
 * The two backend behaviours the NEW PromptX path depends on.
 *
 * `sessions/resolve` is now the minting point: it is the only place where the
 * backend has resolved who is talking, from channel identifiers, before any AI
 * has seen the message. The flow that used to run that resolution as its own
 * SQL now calls this and receives an opaque capability.
 *
 * `conversations/takeover` used to be written by the flow as direct SQL on
 * conversations.takeover_state, with an id the flow chose.
 */

let server: any = null;
let ready = false;
let skipReason = "";

const contexts: string[] = [];
let A = { conversationId: 0, projectId: 1, orgId: "org_default", customerRef: "", destination: "" };
let B = { conversationId: 0, projectId: 101, orgId: "org_excise" };

describe("NEW path — capability minting and takeover (live)", () => {
  before(async () => {
    try {
      // Must match what sessions/resolve itself picks: the identity's most
      // recent open conversation. Choosing a different one made this test
      // fail for the wrong reason - some identities have a newer conversation
      // with a NULL project_id, which cannot be given a capability at all.
      const a = await pool.query(
        `SELECT c.id, c.project_id, c.org_id, i.channel_ref
           FROM conversations c
           JOIN identities i ON i.id = c.identity_id
          WHERE c.deleted_at IS NULL
            AND i.channel_ref IS NOT NULL
            AND c.project_id IS NOT NULL
            AND c.id = (
              SELECT c2.id FROM conversations c2
               WHERE c2.identity_id = c.identity_id AND c2.deleted_at IS NULL
               ORDER BY c2.updated_at DESC NULLS LAST, c2.created_at DESC, c2.id DESC
               LIMIT 1
            )
          ORDER BY c.id DESC LIMIT 1`
      );
      const b = await pool.query(
        `SELECT id, project_id, org_id FROM conversations
          WHERE project_id = 101 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`
      );
      if (!a.rows.length || !b.rows.length) {
        skipReason = "a LINE identity in project 1 and a conversation in project 101 are required";
        return;
      }
      A = {
        conversationId: Number(a.rows[0].id),
        projectId: Number(a.rows[0].project_id),
        orgId: String(a.rows[0].org_id),
        customerRef: String(a.rows[0].channel_ref),
        destination: "",
      };
      B = {
        conversationId: Number(b.rows[0].id),
        projectId: Number(b.rows[0].project_id),
        orgId: String(b.rows[0].org_id),
      };

      const mod = await import("../../src/api/server");
      server = mod.fastify;
      await server.ready();
      mod.registerLocalTools();
      ready = true;
    } catch (err: any) {
      skipReason = err.message;
      console.error("[SessionCapability] setup failed:", err.message);
      ready = false;
    }
  });

  after(async () => {
    if (contexts.length) {
      await pool
        .query(`DELETE FROM execution_contexts WHERE context_id = ANY($1::varchar[])`, [contexts])
        .catch(() => {});
    }
    await pool.query(`DELETE FROM trace_events WHERE correlation_id LIKE 'sesscap-%'`).catch(() => {});
    if (server) await server.close().catch(() => {});
    await pool.end().catch(() => {});
  });

  function auth() {
    return { Authorization: `Bearer ${config.API_KEY}` };
  }

  it("SC-1: sessions/resolve mints a capability bound to the server-resolved tenant", async (t) => {
    if (!ready) return t.skip(skipReason);

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/internal/sessions/resolve",
      headers: auth(),
      payload: {
        channel: "LINE",
        customer_ref: A.customerRef,
        // A project the caller has no business naming. The backend resolves
        // the real one from the identity; this must not become authority.
        project_id: B.projectId,
        message: "capability minting probe",
      },
    });

    assert.strictEqual(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);

    assert.ok(body.execution, "the response must carry an execution block");
    const token = body.execution.execution_context_token;
    assert.ok(token, `a capability must be minted; got ${JSON.stringify(body.execution)}`);

    const resolved = await executionContextService.resolve(token);
    assert.ok(resolved.ok, `the minted token must resolve: ${resolved.failure}`);
    contexts.push(resolved.context!.contextId);

    assert.strictEqual(
      resolved.context!.projectId,
      A.projectId,
      "the capability must bind the server-resolved project, not the one the caller named"
    );
    assert.strictEqual(resolved.context!.orgId, A.orgId);
    assert.strictEqual(body.conversation.project_id, String(A.projectId), "project_id must be reported");
  });

  it("SC-2: the minted capability is accepted by a guarded route", async (t) => {
    if (!ready) return t.skip(skipReason);

    const resolve = await server.inject({
      method: "POST",
      url: "/api/v1/internal/sessions/resolve",
      headers: auth(),
      payload: { channel: "LINE", customer_ref: A.customerRef, message: "probe" },
    });
    const token = JSON.parse(resolve.body).execution?.execution_context_token;
    assert.ok(token, "minting is a precondition of this test");
    const r = await executionContextService.resolve(token);
    if (r.ok) contexts.push(r.context!.contextId);

    // The whole point of minting: the flow can now reach a guarded route.
    const find = await server.inject({
      method: "POST",
      url: "/api/v1/internal/tickets/find",
      headers: { ...auth(), "x-execution-context": token },
      payload: {},
    });
    assert.strictEqual(find.statusCode, 200, `guarded route rejected the minted capability: ${find.body}`);

    for (const ticket of JSON.parse(find.body).tickets || []) {
      assert.strictEqual(String(ticket.project_id), String(A.projectId), "results must stay in the minted tenant");
    }
  });

  it("SC-3: takeover requires a capability and ignores a caller-named conversation", async (t) => {
    if (!ready) return t.skip(skipReason);

    const none = await server.inject({
      method: "POST",
      url: "/api/v1/internal/conversations/takeover",
      headers: auth(),
      payload: { conversationId: A.conversationId },
    });
    assert.strictEqual(none.statusCode, 403, `takeover without a capability returned ${none.statusCode}`);
    assert.strictEqual(JSON.parse(none.body).code, "EXECUTION_CONTEXT_REQUIRED");

    const minted = await executionContextService.create({
      channel: "line",
      conversationId: A.conversationId,
      projectId: A.projectId,
      orgId: A.orgId,
      correlationId: `sesscap-takeover-${Date.now()}`,
    });
    contexts.push(minted.context.contextId);

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/internal/conversations/takeover",
      headers: { ...auth(), "x-execution-context": minted.token },
      // Naming another tenant's conversation. The flow used to choose this id.
      payload: { conversationId: B.conversationId, reasonCode: "TEST", source: "promptx" },
    });

    assert.strictEqual(res.statusCode, 200, res.body);
    assert.strictEqual(
      Number(JSON.parse(res.body).conversation_id),
      A.conversationId,
      "takeover must act on the context's conversation, not the one named in the body"
    );

    const other = await pool.query(`SELECT takeover_state FROM conversations WHERE id = $1`, [B.conversationId]);
    assert.notStrictEqual(
      other.rows[0]?.takeover_state,
      "pending_human_takeover",
      "the other tenant's conversation must be untouched"
    );

    // The takeover itself is recorded...
    const recorded = await pool.query(
      `SELECT conversation_id FROM trace_events
        WHERE correlation_id = $1 AND event_type = 'takeover_requested' LIMIT 1`,
      [minted.context.correlationId]
    );
    assert.ok(recorded.rows.length, "the takeover must be recorded");
    assert.strictEqual(Number(recorded.rows[0].conversation_id), A.conversationId);

    // ...and the attempt to name another conversation is recorded by the
    // middleware, which sees it before the handler does.
    const attempt = await pool.query(
      `SELECT detail FROM trace_events
        WHERE correlation_id = $1 AND event_type = 'forbidden_fields_ignored' LIMIT 1`,
      [minted.context.correlationId]
    );
    assert.ok(attempt.rows.length, "the claimed conversation must be recorded as an attempt");
    assert.strictEqual(
      String(attempt.rows[0].detail.claimed.conversationId),
      String(B.conversationId),
      "the claimed conversation must be preserved as evidence"
    );
  });
});
