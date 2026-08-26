import { pool } from "../adapters/postgres/PostgresAdapter";
import { createLogger } from "./logger";

const logger = createLogger("trace");

/**
 * Causal trace — the B-5 boundary.
 *
 * Nothing recorded PromptX or AgentX execution ids, so "this ticket exists
 * and an AgentX call happened" was the strongest available claim. That is
 * correlation, not causality.
 *
 * Every row here carries a correlation id and its parent's, so a ticket can
 * be walked back to the LINE event that caused it. Evidence is persisted in
 * Postgres, not logged: a console line is not queryable and does not survive
 * a restart.
 *
 * External ids are recorded when a component supplies one and left NULL when
 * it does not. A null is honest. An invented id would make the chain look
 * complete while proving nothing, which is worse than an obvious gap.
 */

export type TraceComponent =
  | "line_webhook"
  | "promptx"
  | "agentx_gate"
  | "agentx_support"
  | "mcp"
  | "ticketx"
  | "outbox"
  | "plane"
  | "reverse_sync"
  | "notification";

export interface TraceEvent {
  correlationId: string;
  parentCorrelationId?: string | null;
  component: TraceComponent;
  eventType: string;
  status?: "ok" | "failed" | "skipped";
  /** The component's own execution id, when it provides one. Never invented. */
  externalExecutionId?: string | null;
  lineEventId?: string | null;
  conversationId?: number | null;
  identityId?: number | null;
  ticketId?: number | null;
  outboxEventId?: number | null;
  planeIssueId?: string | null;
  projectId?: number | null;
  orgId?: string | null;
  detail?: Record<string, unknown> | null;
  errorMessage?: string | null;
}

/**
 * Keys that must never reach the trace store. Values are dropped, not
 * redacted, so a partial value cannot be reassembled from several rows.
 */
const FORBIDDEN_DETAIL_KEYS = [
  "authorization",
  "auth",
  "token",
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "secret",
  "password",
  "credential",
  "credential_ref",
  "credentialref",
  "plane_api_key",
  "planeapikey",
  "channel_secret",
  "channelsecret",
  "session_secret",
  "sessionsecret",
  "cookie",
  "bearer",
];

/** Recursively strips anything credential-shaped from a detail payload. */
export function sanitizeDetail(detail: unknown, depth = 0): unknown {
  if (depth > 4 || detail === null || detail === undefined) return detail ?? null;
  if (Array.isArray(detail)) return detail.slice(0, 20).map((d) => sanitizeDetail(d, depth + 1));
  if (typeof detail !== "object") {
    const s = String(detail);
    // Defence in depth: a value that looks like a credential is dropped even
    // if its key looked innocent.
    if (/^(Bearer\s+)?[A-Za-z0-9_\-]{40,}$/.test(s) || /^plane_api_[a-f0-9]{20,}/i.test(s)) {
      return "[redacted]";
    }
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if (FORBIDDEN_DETAIL_KEYS.includes(k.toLowerCase())) continue;
    out[k] = sanitizeDetail(v, depth + 1);
  }
  return out;
}

export class TraceRecorder {
  /**
   * Appends one event. Never throws: losing a trace row is bad, but failing
   * a customer's request because the trace table was unavailable is worse.
   */
  async record(event: TraceEvent): Promise<number | null> {
    try {
      const { rows } = await pool.query(
        `INSERT INTO trace_events
           (correlation_id, parent_correlation_id, component, event_type, status,
            external_execution_id, line_event_id, conversation_id, identity_id,
            ticket_id, outbox_event_id, plane_issue_id, project_id, org_id,
            detail, error_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id`,
        [
          event.correlationId,
          event.parentCorrelationId ?? null,
          event.component,
          event.eventType,
          event.status ?? "ok",
          event.externalExecutionId ?? null,
          event.lineEventId ?? null,
          event.conversationId ?? null,
          event.identityId ?? null,
          event.ticketId ?? null,
          event.outboxEventId ?? null,
          event.planeIssueId ?? null,
          event.projectId ?? null,
          event.orgId ?? null,
          event.detail ? JSON.stringify(sanitizeDetail(event.detail)) : null,
          event.errorMessage ? String(event.errorMessage).slice(0, 1000) : null,
        ]
      );
      return rows.length ? Number(rows[0].id) : null;
    } catch (err: any) {
      logger.warn(
        { error: err.message, component: event.component, eventType: event.eventType },
        "Could not persist trace event"
      );
      return null;
    }
  }

  /**
   * The query the gate requires: given a ticket, return the full chain back
   * to the LINE event.
   *
   * Walks by correlation id and by the ticket's own recorded correlation, so
   * events written before the ticket existed are still included.
   */
  async chainForTicket(ticketId: number): Promise<{
    ticketId: number;
    correlationId: string | null;
    events: any[];
    missingLinks: string[];
  }> {
    const t = await pool.query(
      `SELECT id, correlation_id, execution_context_id, conversation_id, project_id, org_id,
              plane_issue_id, ticket_number
         FROM tickets WHERE id = $1 LIMIT 1`,
      [ticketId]
    );
    const correlationId: string | null = t.rows[0]?.correlation_id ?? null;

    const { rows } = await pool.query(
      `SELECT id, correlation_id, parent_correlation_id, component, event_type, status,
              external_execution_id, line_event_id, conversation_id, identity_id,
              ticket_id, outbox_event_id, plane_issue_id, project_id, org_id,
              detail, error_message, occurred_at
         FROM trace_events
        WHERE ticket_id = $1
           OR ($2::varchar IS NOT NULL AND correlation_id = $2)
           OR ($2::varchar IS NOT NULL AND parent_correlation_id = $2)
        ORDER BY id ASC`,
      [ticketId, correlationId]
    );

    // Report which required links are genuinely absent rather than implying a
    // complete chain.
    const seen = new Set(rows.map((r: any) => r.component));
    const required: TraceComponent[] = [
      "line_webhook",
      "promptx",
      "agentx_gate",
      "agentx_support",
      "mcp",
      "ticketx",
    ];
    const missingLinks = required.filter((c) => !seen.has(c));

    return { ticketId, correlationId, events: rows, missingLinks };
  }
}

export const traceRecorder = new TraceRecorder();
