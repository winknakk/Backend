import { createLogger } from "../../observability/logger";

const logger = createLogger("outbox-failure");

/**
 * How an outbox dispatch failed, and therefore what should happen next.
 *
 *  transient  the operation may succeed later (5xx, 429, network, timeout).
 *             Retried with exponential backoff.
 *  permanent  the payload itself is unacceptable and will never be accepted
 *             (400, 404, validation rejections, missing required fields).
 *             Dead-lettered immediately — retrying wastes attempts and delays
 *             everything behind it in the queue.
 *  blocked    the request is well-formed but the caller is not permitted
 *             (401, 403, unresolvable credentials). An operator has to fix
 *             configuration; hammering the API will not help.
 */
export type OutboxFailureKind = "transient" | "permanent" | "blocked";

/** Substrings that identify a payload the remote system will never accept. */
const PERMANENT_ERROR_PATTERNS = [
  "custom id cannot be integers",
  "is missing in outbox payload",
  "conversation_not_found",
  "ticket not found",
  "plane_conflict_unresolved",
  "invalid payload",
];

/** Substrings that identify a configuration or permission problem. */
const BLOCKED_ERROR_PATTERNS = [
  "plane_credential_error",
  "plane_mapping_not_found",
  "status code 401",
  "status code 403",
];

export function classifyOutboxFailure(err: any): OutboxFailureKind {
  const status: number | undefined = err?.response?.status;
  const message = String(err?.message || "").toLowerCase();

  if (BLOCKED_ERROR_PATTERNS.some((p) => message.includes(p))) return "blocked";
  if (PERMANENT_ERROR_PATTERNS.some((p) => message.includes(p))) return "permanent";

  if (typeof status === "number") {
    if (status === 401 || status === 403) return "blocked";
    if (status === 429) return "transient";
    if (status >= 500) return "transient";
    if (status >= 400) return "permanent";
  }

  // No HTTP status at all: DNS failure, connection reset, client timeout.
  if (!status) return "transient";

  return "transient";
}

/**
 * Backoff before the next attempt. Grows exponentially from one minute and
 * caps at an hour, so a long outage does not turn into a hot loop against a
 * struggling dependency.
 */
export function backoffMs(attempts: number): number {
  const base = 60_000;
  const capped = Math.min(base * Math.pow(2, Math.max(0, attempts - 1)), 3_600_000);
  return capped;
}

export function logClassification(id: number, eventType: string, kind: OutboxFailureKind, err: any): void {
  const detail = {
    outboxId: id,
    eventType,
    kind,
    status: err?.response?.status,
    error: err?.message,
  };
  if (kind === "transient") {
    logger.warn(detail, "Outbox dispatch failed; will retry");
  } else {
    logger.error(detail, `Outbox dispatch failed permanently (${kind}); dead-lettering without retry`);
  }
}
