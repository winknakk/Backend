import { pool } from "../adapters/postgres/PostgresAdapter";
import { createLogger } from "../observability/logger";

const logger = createLogger("OperationsFeedService");

export interface OperationsFeedEvent {
  id: string;
  category: "verification" | "automation" | "handoff" | "system";
  text: string;
  component: string;
  eventType: string;
  status: string;
  conversationId: string | null;
  ticketId: string | null;
  createdAt: string;
  timestamp: string;
  detail?: any;
}

export class OperationsFeedService {
  private pool: any;

  constructor(customPool?: any) {
    this.pool = customPool || pool;
  }

  /**
   * Retrieves chronological operational events scoped strictly to authorized project IDs.
   */
  async getRecentEvents(
    projectIds: number[] | null,
    limit: number = 20
  ): Promise<OperationsFeedEvent[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 50);

    try {
      // 1. Query trace_events (Causal traces from migration 042)
      const traceEventsSql = `
        SELECT 
          CONCAT('te-', id) AS id,
          CASE 
            WHEN component = 'line_webhook' THEN 'verification'
            WHEN component IN ('agentx_gate', 'agentx_support', 'mcp') THEN 'automation'
            WHEN component IN ('human_takeover', 'human_reply') THEN 'handoff'
            ELSE 'automation'
          END AS category,
          component,
          event_type,
          status,
          conversation_id,
          ticket_id,
          detail,
          occurred_at AS created_at
        FROM trace_events
        WHERE ($1::integer[] IS NULL OR project_id = ANY($1::integer[]))
        ORDER BY id DESC
        LIMIT $2::integer
      `;

      const traceRes = await this.pool.query(traceEventsSql, [projectIds, boundedLimit]);

      let events: OperationsFeedEvent[] = traceRes.rows.map((row: any) => {
        const text = this.formatEventDescription(row.component, row.event_type, row.status, row.detail);
        const createdAtIso = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
        return {
          id: String(row.id),
          category: row.category as any,
          text,
          component: row.component,
          eventType: row.event_type,
          status: row.status,
          conversationId: row.conversation_id ? String(row.conversation_id) : null,
          ticketId: row.ticket_id ? String(row.ticket_id) : null,
          createdAt: createdAtIso,
          timestamp: this.formatRelativeTime(row.created_at),
          detail: row.detail || undefined,
        };
      });

      // 2. If fewer than requested limit, supplement with recent outbox_events
      if (events.length < boundedLimit) {
        const remaining = boundedLimit - events.length;
        const outboxSql = `
          SELECT 
            CONCAT('oe-', id) AS id,
            CASE 
              WHEN event_type LIKE '%handoff%' OR event_type LIKE '%takeover%' THEN 'handoff'
              WHEN event_type LIKE '%ticket%' THEN 'automation'
              ELSE 'automation'
            END AS category,
            'outbox' AS component,
            event_type,
            status,
            NULL::integer AS conversation_id,
            NULLIF(regexp_replace(aggregate_id, '[^0-9]', '', 'g'), '')::integer AS ticket_id,
            payload AS detail,
            created_at
          FROM outbox_events
          WHERE ($1::integer[] IS NULL OR project_id = ANY($1::integer[]))
          ORDER BY id DESC
          LIMIT $2::integer
        `;
        const outboxRes = await this.pool.query(outboxSql, [projectIds, remaining]);
        const outboxEvents: OperationsFeedEvent[] = outboxRes.rows.map((row: any) => {
          const text = `Outbox event: ${row.event_type} (${row.status})`;
          const createdAtIso = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
          return {
            id: String(row.id),
            category: row.category as any,
            text,
            component: row.component,
            eventType: row.event_type,
            status: row.status,
            conversationId: null,
            ticketId: row.ticket_id ? String(row.ticket_id) : null,
            createdAt: createdAtIso,
            timestamp: this.formatRelativeTime(row.created_at),
            detail: row.detail || undefined,
          };
        });
        events = [...events, ...outboxEvents].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        ).slice(0, boundedLimit);
      }

      return events;
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to fetch operational feed events from PostgreSQL");
      return [];
    }
  }

  private formatEventDescription(component: string, eventType: string, status: string, detail?: any): string {
    if (eventType === "session_resolved") {
      const channel = detail?.channel ? String(detail.channel).toUpperCase() : "channel";
      return `Session execution context resolved for ${channel} message`;
    }
    if (eventType === "ticket_created" || eventType === "create_ticket") {
      return `Support ticket created (${status})`;
    }
    if (eventType === "takeover_started" || eventType === "takeover") {
      return `Human takeover requested / initiated`;
    }
    if (eventType === "ticket_promoted" || component === "plane") {
      return `Ticket synchronized with Plane.so (${status})`;
    }
    return `${component}: ${eventType.replace(/_/g, " ")} (${status})`;
  }

  private formatRelativeTime(dateInput: any): string {
    if (!dateInput) return "Just now";
    const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
    const now = Date.now();
    const diffMs = Math.max(0, now - date.getTime());
    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }
}

export const operationsFeedService = new OperationsFeedService();
