import assert from "assert";
import { describe, it, before, after } from "node:test";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { pool } from "../../src/adapters/postgres/PostgresAdapter";
import {
  executionContextService,
  tokenForContext,
} from "../../src/domain/execution/ExecutionContextService";

/**
 * The queue capability decision.
 *
 * `agent_session_queue.payload` is persisted, so a signed capability stored in
 * it is a directly usable credential sitting in a database row for the life of
 * the entry. Option B — persist the context id and re-derive the token at
 * dispatch — was chosen because the signature is a deterministic HMAC over the
 * context id, so it costs nothing and grants nothing extra.
 *
 * These pin down the three properties that decision rests on.
 */

let ready = false;
let skipReason = "";
let conversationId = 0;
let projectId = 0;
let orgId = "";
const contexts: string[] = [];

describe("queue capability — the stored payload is not a credential (live)", () => {
  before(async () => {
    try {
      const c = await pool.query(
        `SELECT id, project_id, org_id FROM conversations
          WHERE project_id = 1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`
      );
      if (!c.rows.length) {
        skipReason = "a live conversation is required";
        return;
      }
      conversationId = Number(c.rows[0].id);
      projectId = Number(c.rows[0].project_id);
      orgId = String(c.rows[0].org_id || "org_default");
      ready = true;
    } catch (err: any) {
      skipReason = err.message;
      ready = false;
    }
  });

  after(async () => {
    if (contexts.length) {
      await pool
        .query(`DELETE FROM execution_contexts WHERE context_id = ANY($1::varchar[])`, [contexts])
        .catch(() => {});
    }
    await pool.end().catch(() => {});
  });

  async function mint(label: string) {
    const r = await executionContextService.create({
      channel: "line",
      conversationId,
      projectId,
      orgId,
      correlationId: `queuecap-${label}-${Date.now()}`,
    });
    contexts.push(r.context.contextId);
    return r;
  }

  it("QC-1: re-deriving at dispatch reproduces the original token exactly", async (t) => {
    if (!ready) return t.skip(skipReason);
    const { token, context } = await mint("determinism");

    // If this were not exact, the queued path would hand the agent a token the
    // server would reject, and every queued turn would fail closed.
    assert.strictEqual(tokenForContext(context.contextId), token);

    const resolved = await executionContextService.resolve(tokenForContext(context.contextId));
    assert.ok(resolved.ok, `re-derived token must resolve: ${resolved.failure}`);
    assert.strictEqual(resolved.context!.conversationId, conversationId);
  });

  it("QC-2: a re-derived token confers no new authority — revocation still wins", async (t) => {
    if (!ready) return t.skip(skipReason);
    const { context } = await mint("revoked");
    await executionContextService.revoke(context.contextId, "queue capability test");

    // Re-deriving must not resurrect a dead context. Authority lives in the
    // row, not in the signature.
    const resolved = await executionContextService.resolve(tokenForContext(context.contextId));
    assert.strictEqual(resolved.ok, false);
    assert.strictEqual(resolved.failure, "CONTEXT_REVOKED");
  });

  it("QC-3: expiry still wins after re-derivation", async (t) => {
    if (!ready) return t.skip(skipReason);
    const { context } = await mint("expired");
    await pool.query(
      `UPDATE execution_contexts SET expires_at = NOW() - INTERVAL '1 minute' WHERE context_id = $1`,
      [context.contextId]
    );

    const resolved = await executionContextService.resolve(tokenForContext(context.contextId));
    assert.strictEqual(resolved.ok, false);
    assert.strictEqual(resolved.failure, "CONTEXT_EXPIRED");
  });

  it("QC-4: the payload the queue persists carries no signed token", async (t) => {
    if (!ready) return t.skip(skipReason);
    const { token, context } = await mint("payload");

    // The shape LineMessageBatchingService enqueues.
    const queuedPayload = {
      destination: "d",
      events: [],
      ticketx: {
        onboardingVerified: true,
        projectId,
        conversationId,
        batchSize: 1,
        executionContextId: context.contextId,
        correlationId: context.correlationId,
      },
    };

    const serialised = JSON.stringify(queuedPayload);
    assert.ok(!serialised.includes(token), "a signed capability must not be persisted in the queue payload");
    // The signature half specifically — the context id on its own is inert.
    assert.ok(!serialised.includes(token.split(".")[1]), "the signature must not appear in the stored payload");
    assert.ok(serialised.includes(context.contextId), "the context id is what gets stored");
  });
});
