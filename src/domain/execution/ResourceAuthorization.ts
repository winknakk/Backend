import { pool } from "../../adapters/postgres/PostgresAdapter";
import { createLogger } from "../../observability/logger";
import { traceRecorder } from "../../observability/TraceRecorder";
import { TrustedContext } from "./ExecutionContextService";

const logger = createLogger("resource-authorization");

/**
 * Resource authorization against the trusted execution context — B-0b.
 *
 * The division of responsibility, stated once so every caller can rely on it:
 *
 *   The agent chooses WHAT it wants to operate on.
 *   The server decides WHETHER it is allowed to operate on it.
 *
 * So a ticket id MAY come from the model — it is a resource identifier, not an
 * authority claim. What must never come from the model is the tenant the
 * operation runs against. Every lookup here re-derives org and project from
 * the execution context and refuses anything outside it.
 *
 * This exists because `create_ticket` was not the only tool taking tenant
 * fields from the agent. Nine others did, and two of them reached Postgres
 * directly, where no middleware could intervene.
 */

export type AuthorizationFailure =
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_OUT_OF_SCOPE"
  | "RESOURCE_REFERENCE_INVALID";

export interface AuthorizedTicket {
  id: number;
  ticketNumber: string | null;
  ticketId: string | null;
  conversationId: number | null;
  projectId: number;
  orgId: string;
  status: string;
  planeIssueId: string | null;
}

export interface AuthorizedConversation {
  id: number;
  identityId: number | null;
  projectId: number;
  orgId: string;
}

export interface AuthorizationResult<T> {
  ok: boolean;
  resource?: T;
  failure?: AuthorizationFailure;
  reason?: string;
}

/**
 * A reference is accepted as a ticket number (`TCK-…`), a legacy `ticket_id`,
 * or a numeric primary key. It is never interpolated — only bound.
 */
function referenceForms(raw: string): { text: string; numeric: number | null } {
  const text = String(raw ?? "").trim();
  // Strict: "12abc" must not silently become 12, the way parseInt would.
  const numeric = /^[0-9]+$/.test(text) ? Number(text) : null;
  return { text, numeric };
}

async function recordDenial(
  context: TrustedContext,
  kind: string,
  reference: string,
  failure: AuthorizationFailure,
  found?: { projectId?: number | null; orgId?: string | null }
): Promise<void> {
  logger.warn(
    {
      kind,
      reference: String(reference).slice(0, 64),
      failure,
      contextProject: context.projectId,
      contextOrg: context.orgId,
      resourceProject: found?.projectId ?? null,
      resourceOrg: found?.orgId ?? null,
    },
    "Refused a resource outside the caller's execution context"
  );

  await traceRecorder.record({
    correlationId: context.correlationId,
    component: "mcp",
    eventType: "resource_access_denied",
    status: "failed",
    conversationId: context.conversationId,
    projectId: context.projectId,
    orgId: context.orgId,
    detail: {
      kind,
      reference: String(reference).slice(0, 64),
      failure,
      // Recorded so a cross-tenant attempt is investigable afterwards. These
      // are the resource's own values, never anything the agent claimed.
      resourceProjectId: found?.projectId ?? null,
      resourceOrgId: found?.orgId ?? null,
    },
  });
}

/**
 * Resolves a ticket reference and proves it belongs to this execution.
 *
 * Deliberately two steps — look up unscoped, then compare — rather than one
 * scoped query. Both return the same answer to the caller, but this way the
 * denial can be recorded with what the resource ACTUALLY belonged to, which is
 * what makes a cross-tenant attempt visible afterwards instead of looking
 * identical to a typo.
 */
export async function authorizeTicket(
  context: TrustedContext,
  reference: unknown
): Promise<AuthorizationResult<AuthorizedTicket>> {
  const { text, numeric } = referenceForms(String(reference ?? ""));
  if (!text) {
    return { ok: false, failure: "RESOURCE_REFERENCE_INVALID", reason: "A ticket reference is required" };
  }

  const { rows } = await pool.query(
    `SELECT id, ticket_number, ticket_id, conversation_id, project_id, org_id, status, plane_issue_id
       FROM tickets
      WHERE ticket_number = $1 OR ticket_id = $1 OR ($2::int IS NOT NULL AND id = $2)
      LIMIT 1`,
    [text, numeric]
  );

  if (rows.length === 0) {
    await recordDenial(context, "ticket", text, "RESOURCE_NOT_FOUND");
    return { ok: false, failure: "RESOURCE_NOT_FOUND", reason: `Ticket ${text} does not exist` };
  }

  const row = rows[0];
  const sameOrg = String(row.org_id) === String(context.orgId);
  const sameProject = Number(row.project_id) === Number(context.projectId);

  if (!sameOrg || !sameProject) {
    await recordDenial(context, "ticket", text, "RESOURCE_OUT_OF_SCOPE", {
      projectId: row.project_id,
      orgId: row.org_id,
    });
    // Same shape as NOT_FOUND to the caller: confirming a ticket exists in
    // another tenant is itself a disclosure.
    return { ok: false, failure: "RESOURCE_OUT_OF_SCOPE", reason: `Ticket ${text} is not accessible` };
  }

  return {
    ok: true,
    resource: {
      id: Number(row.id),
      ticketNumber: row.ticket_number ?? null,
      ticketId: row.ticket_id ?? null,
      conversationId: row.conversation_id === null ? null : Number(row.conversation_id),
      projectId: Number(row.project_id),
      orgId: String(row.org_id),
      status: String(row.status),
      planeIssueId: row.plane_issue_id ?? null,
    },
  };
}

/**
 * Proves a conversation belongs to this execution's identity, project and org.
 *
 * All three are checked. Project alone is not enough: two customers can share
 * a project, and a conversation is a per-customer thread.
 */
export async function authorizeConversation(
  context: TrustedContext,
  reference: unknown
): Promise<AuthorizationResult<AuthorizedConversation>> {
  const { numeric } = referenceForms(String(reference ?? ""));
  if (numeric === null || numeric <= 0) {
    return { ok: false, failure: "RESOURCE_REFERENCE_INVALID", reason: "A numeric conversation id is required" };
  }

  const { rows } = await pool.query(
    `SELECT id, identity_id, project_id, org_id
       FROM conversations
      WHERE id = $1 AND deleted_at IS NULL
      LIMIT 1`,
    [numeric]
  );

  if (rows.length === 0) {
    await recordDenial(context, "conversation", String(numeric), "RESOURCE_NOT_FOUND");
    return { ok: false, failure: "RESOURCE_NOT_FOUND", reason: `Conversation ${numeric} does not exist` };
  }

  const row = rows[0];
  const sameOrg = String(row.org_id) === String(context.orgId);
  const sameProject = Number(row.project_id) === Number(context.projectId);
  // identity_id is only compared when the context carries one; a context minted
  // without an identity must not silently widen to every identity in the
  // project, so in that case only the context's own conversation is accepted.
  const sameIdentity =
    context.identityId !== null && context.identityId !== undefined
      ? Number(row.identity_id) === Number(context.identityId)
      : Number(row.id) === Number(context.conversationId);

  if (!sameOrg || !sameProject || !sameIdentity) {
    await recordDenial(context, "conversation", String(numeric), "RESOURCE_OUT_OF_SCOPE", {
      projectId: row.project_id,
      orgId: row.org_id,
    });
    return { ok: false, failure: "RESOURCE_OUT_OF_SCOPE", reason: `Conversation ${numeric} is not accessible` };
  }

  return {
    ok: true,
    resource: {
      id: Number(row.id),
      identityId: row.identity_id === null ? null : Number(row.identity_id),
      projectId: Number(row.project_id),
      orgId: String(row.org_id),
    },
  };
}

/** Maps an authorization failure onto an HTTP status. */
export function authorizationStatus(failure: AuthorizationFailure | undefined): number {
  return failure === "RESOURCE_REFERENCE_INVALID" ? 400 : 404;
}

/**
 * Looks a ticket up without applying any tenant scope.
 *
 * Only for callers that authorize by a DIFFERENT authority than the execution
 * context — specifically a console operator, whose scope comes from their own
 * principal. Never call this and then skip the scope check; the whole point of
 * returning the row unscoped is that the caller still has to prove access.
 */
export async function findTicketByReference(reference: unknown): Promise<AuthorizedTicket | null> {
  const { text, numeric } = referenceForms(String(reference ?? ""));
  if (!text) return null;

  const { rows } = await pool.query(
    `SELECT id, ticket_number, ticket_id, conversation_id, project_id, org_id, status, plane_issue_id
       FROM tickets
      WHERE ticket_number = $1 OR ticket_id = $1 OR ($2::int IS NOT NULL AND id = $2)
      LIMIT 1`,
    [text, numeric]
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: Number(row.id),
    ticketNumber: row.ticket_number ?? null,
    ticketId: row.ticket_id ?? null,
    conversationId: row.conversation_id === null ? null : Number(row.conversation_id),
    projectId: Number(row.project_id),
    orgId: String(row.org_id),
    status: String(row.status),
    planeIssueId: row.plane_issue_id ?? null,
  };
}
