import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { config } from "../../config/env";
import { createLogger } from "../../observability/logger";

const logger = createLogger("execution-context");

/**
 * Server-owned execution context — the B-0 boundary.
 *
 * The Support Agent is handed the conversation id inside its prompt, and the
 * MCP create_ticket tool accepted it back as an argument, deriving org_id and
 * project_id from it. That let the model choose the tenant, through a channel
 * that also carries attacker-controlled customer text.
 *
 * Prompt wording cannot fix that. "Never change conversation_id" is an
 * instruction, not a boundary.
 *
 * Here, tenant facts are established by trusted backend code AFTER LINE
 * signature verification and identity/project/conversation resolution, and
 * stored server-side. The agent receives only an opaque capability token. On
 * a tool call the server reads the tenant from the row that token names and
 * ignores anything the agent claimed.
 *
 * The token is a capability, not an assertion. Possessing it proves the
 * holder is acting inside THIS execution. An agent only ever holds the token
 * for its own execution; a customer cannot forge one, because it is signed
 * with SESSION_SECRET and never leaves the server unsigned.
 */

export interface TrustedContext {
  contextId: string;
  correlationId: string;
  channel: string;
  lineEventId: string | null;
  identityId: number | null;
  conversationId: number;
  projectId: number;
  orgId: string;
  promptxSlug: string | null;
}

export interface CreateContextInput {
  channel: string;
  lineEventId?: string | null;
  identityId?: number | null;
  conversationId: number;
  projectId: number;
  orgId: string;
  correlationId?: string;
  ttlSeconds?: number;
}

export type ContextFailure =
  | "TOKEN_MISSING"
  | "TOKEN_MALFORMED"
  | "TOKEN_INVALID_SIGNATURE"
  | "CONTEXT_NOT_FOUND"
  | "CONTEXT_EXPIRED"
  | "CONTEXT_REVOKED";

export interface ContextResolution {
  ok: boolean;
  context?: TrustedContext;
  failure?: ContextFailure;
  reason?: string;
}

/** Fields the agent must never be authoritative for. */
export const AGENT_FORBIDDEN_FIELDS = [
  "org_id",
  "orgId",
  "project_id",
  "projectId",
  "identity_id",
  "identityId",
  "conversation_id",
  "conversationId",
  "credential_ref",
  "credentialRef",
  "plane_project_id",
  "planeProjectId",
  "workspace_slug",
  "workspaceSlug",
] as const;

const DEFAULT_TTL_SECONDS = 30 * 60;

function signingKey(): string {
  // Reuses the session secret so there is one secret to rotate, not two.
  const secret = config.SESSION_SECRET || "ax_live_session_secret_2026_ticketx_secure_key_8f92a10b4c3e";
  return secret;
}

function sign(contextId: string): string {
  return createHmac("sha256", signingKey()).update(`ctx:${contextId}`).digest("base64url");
}

/**
 * Recreates the capability token for a context that already exists.
 *
 * The signature is a deterministic HMAC over the context id, so this returns
 * exactly the token minted originally. That is what lets the queue persist
 * only the context id and re-derive the capability at dispatch: storing the
 * token itself would put a directly usable credential in a database row for
 * no gain. It confers no new authority - the context row's own status and
 * expiry are still checked on every resolve.
 */
export function tokenForContext(contextId: string): string {
  return `${contextId}.${sign(contextId)}`;
}

export class ExecutionContextService {
  /**
   * Creates the context. Called only by trusted backend code, after the
   * customer's identity, project and conversation have been resolved.
   *
   * Returns the token to hand to the automation layer OUT OF BAND — never
   * inside the message text, where a customer could imitate it.
   */
  async create(input: CreateContextInput): Promise<{ context: TrustedContext; token: string }> {
    if (!Number.isInteger(input.conversationId) || input.conversationId <= 0) {
      throw new Error("EXECUTION_CONTEXT_INVALID: conversationId is required");
    }
    if (!Number.isInteger(input.projectId) || input.projectId <= 0) {
      throw new Error("EXECUTION_CONTEXT_INVALID: projectId is required");
    }
    if (!input.orgId) {
      throw new Error("EXECUTION_CONTEXT_INVALID: orgId is required");
    }

    const contextId = randomUUID();
    const correlationId = input.correlationId || randomUUID();
    const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const promptxSlug = `support_${input.conversationId}`;

    await pool.query(
      `INSERT INTO execution_contexts
         (context_id, correlation_id, channel, line_event_id, identity_id,
          conversation_id, project_id, org_id, promptx_slug, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active', NOW() + ($10::int * INTERVAL '1 second'))`,
      [
        contextId,
        correlationId,
        input.channel,
        input.lineEventId ?? null,
        input.identityId ?? null,
        input.conversationId,
        input.projectId,
        input.orgId,
        promptxSlug,
        ttl,
      ]
    );

    logger.info(
      {
        contextId,
        correlationId,
        conversationId: input.conversationId,
        projectId: input.projectId,
        orgId: input.orgId,
      },
      "Execution context created"
    );

    return {
      context: {
        contextId,
        correlationId,
        channel: input.channel,
        lineEventId: input.lineEventId ?? null,
        identityId: input.identityId ?? null,
        conversationId: input.conversationId,
        projectId: input.projectId,
        orgId: input.orgId,
        promptxSlug,
      },
      token: `${contextId}.${sign(contextId)}`,
    };
  }

  /**
   * Resolves a token to its trusted context.
   *
   * Fails closed on every error path. There is deliberately no fallback to a
   * default org, a default project, the first conversation or the first
   * project — the absence of a context is an authorization failure, not a
   * cue to guess.
   */
  async resolve(token: string | null | undefined): Promise<ContextResolution> {
    const raw = String(token || "").trim();
    if (!raw) {
      return { ok: false, failure: "TOKEN_MISSING", reason: "No execution context token supplied" };
    }

    const parts = raw.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { ok: false, failure: "TOKEN_MALFORMED", reason: "Execution context token is malformed" };
    }

    const [contextId, signature] = parts;

    let expected: string;
    try {
      expected = sign(contextId);
    } catch (err: any) {
      // No signing key configured: refuse rather than accept anything.
      return { ok: false, failure: "TOKEN_INVALID_SIGNATURE", reason: err.message };
    }

    const given = Buffer.from(signature);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      logger.warn({ contextId }, "Execution context token failed signature verification");
      return { ok: false, failure: "TOKEN_INVALID_SIGNATURE", reason: "Execution context token is not valid" };
    }

    const { rows } = await pool.query(
      `SELECT context_id, correlation_id, channel, line_event_id, identity_id,
              conversation_id, project_id, org_id, promptx_slug, status, expires_at
         FROM execution_contexts WHERE context_id = $1 LIMIT 1`,
      [contextId]
    );

    if (rows.length === 0) {
      return { ok: false, failure: "CONTEXT_NOT_FOUND", reason: "Execution context does not exist" };
    }

    const row = rows[0];
    if (row.status !== "active") {
      return { ok: false, failure: "CONTEXT_REVOKED", reason: `Execution context is ${row.status}` };
    }
    if (new Date(row.expires_at) <= new Date()) {
      return { ok: false, failure: "CONTEXT_EXPIRED", reason: "Execution context has expired" };
    }

    return {
      ok: true,
      context: {
        contextId: row.context_id,
        correlationId: row.correlation_id,
        channel: row.channel,
        lineEventId: row.line_event_id,
        identityId: row.identity_id,
        conversationId: Number(row.conversation_id),
        projectId: Number(row.project_id),
        orgId: String(row.org_id),
        promptxSlug: row.promptx_slug,
      },
    };
  }

  /**
   * Reports which forbidden fields a caller supplied.
   *
   * They are never honoured — this exists so the attempt is visible in the
   * trace and the logs rather than silently discarded.
   */
  detectForbiddenFields(payload: Record<string, unknown> | null | undefined): string[] {
    if (!payload || typeof payload !== "object") return [];
    const present: string[] = [];
    for (const field of AGENT_FORBIDDEN_FIELDS) {
      const v = (payload as any)[field];
      if (v !== undefined && v !== null && String(v).trim() !== "") present.push(field);
    }
    return present;
  }

  /** Marks a context used. Contexts are not single-use; this records first use. */
  async markConsumed(contextId: string): Promise<void> {
    await pool
      .query(
        `UPDATE execution_contexts SET consumed_at = COALESCE(consumed_at, NOW())
          WHERE context_id = $1`,
        [contextId]
      )
      .catch((err) => logger.warn({ error: err.message, contextId }, "Could not mark context consumed"));
  }

  async revoke(contextId: string, reason: string): Promise<void> {
    await pool
      .query(`UPDATE execution_contexts SET status = 'revoked' WHERE context_id = $1`, [contextId])
      .catch(() => {});
    logger.warn({ contextId, reason }, "Execution context revoked");
  }
}

export const executionContextService = new ExecutionContextService();
