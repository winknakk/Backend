import { FastifyRequest, FastifyReply } from "fastify";
import { createLogger } from "../observability/logger";
import { traceRecorder } from "../observability/TraceRecorder";
import {
  TrustedContext,
  executionContextService,
} from "../domain/execution/ExecutionContextService";

const logger = createLogger("execution-context-guard");

declare module "fastify" {
  interface FastifyRequest {
    trustedContext?: TrustedContext;
  }
}

/**
 * Enforces the B-0 boundary on endpoints reachable from the automation layer.
 *
 * Two things happen here, and the order matters:
 *
 *  1. The trusted context is resolved from an opaque capability token, taken
 *     from a header or an out-of-band body field — never from anything the
 *     agent composed.
 *  2. Any tenant-determining field the caller supplied is DISCARDED, and the
 *     attempt is recorded. Handlers downstream read tenant facts from
 *     request.trustedContext only.
 *
 * Fails closed. A missing or invalid context is an authorization error. There
 * is no fallback to a default org or project, no "first conversation", no
 * "first project" — the whole point is that the server refuses to guess when
 * it cannot establish who it is acting for.
 */
export async function requireExecutionContext(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const body = (request.body || {}) as Record<string, unknown>;
  const payload = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;

  const token =
    (request.headers["x-execution-context"] as string) ||
    (payload.executionContextToken as string) ||
    (payload.execution_context_token as string) ||
    (body.executionContextToken as string) ||
    "";

  const resolution = await executionContextService.resolve(token);

  // Record the attempt whether or not it succeeded — a rejected call is
  // exactly the kind of thing that must be visible afterwards.
  const attempted = executionContextService.detectForbiddenFields(payload);

  if (!resolution.ok || !resolution.context) {
    logger.warn(
      { url: request.url, failure: resolution.failure, attemptedFields: attempted },
      "Rejected automation call with no valid execution context"
    );

    await traceRecorder.record({
      correlationId: `rejected-${Date.now()}`,
      component: "ticketx",
      eventType: "execution_context_rejected",
      status: "failed",
      detail: { url: request.url, failure: resolution.failure, attemptedFields: attempted },
      errorMessage: resolution.reason,
    });

    reply.status(403).send({
      error: "Forbidden",
      code: "EXECUTION_CONTEXT_REQUIRED",
      message:
        "A server-issued execution context is required. Tenant identity is never accepted from the caller.",
      failure: resolution.failure,
    });
    return;
  }

  const context = resolution.context;
  request.trustedContext = context;

  if (attempted.length > 0) {
    // The agent tried to name its own tenant. The values are dropped, not
    // honoured, and the attempt is preserved as evidence.
    logger.warn(
      {
        contextId: context.contextId,
        conversationId: context.conversationId,
        attemptedFields: attempted,
        claimed: Object.fromEntries(attempted.map((f) => [f, String((payload as any)[f]).slice(0, 64)])),
      },
      "Caller supplied tenant-determining fields; ignoring them in favour of the server-owned context"
    );

    await traceRecorder.record({
      correlationId: context.correlationId,
      component: "mcp",
      eventType: "forbidden_fields_ignored",
      status: "ok",
      conversationId: context.conversationId,
      projectId: context.projectId,
      orgId: context.orgId,
      detail: {
        attemptedFields: attempted,
        // Claimed values are recorded so an injection attempt can be
        // investigated; they are short-truncated and never acted on.
        claimed: Object.fromEntries(attempted.map((f) => [f, String((payload as any)[f]).slice(0, 64)])),
      },
    });

    for (const field of attempted) {
      delete (payload as any)[field];
      delete (body as any)[field];
    }
  }

  // Overwrite with the authoritative values so a handler that reads the body
  // out of habit still gets the truth rather than the agent's claim.
  payload.conversationId = context.conversationId;
  payload.conversation_id = context.conversationId;
  payload.projectId = context.projectId;
  payload.project_id = context.projectId;
  payload.orgId = context.orgId;
  payload.org_id = context.orgId;

  await executionContextService.markConsumed(context.contextId);
}
