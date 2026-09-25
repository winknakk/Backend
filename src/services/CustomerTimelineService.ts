import { pool } from "../adapters/postgres/PostgresAdapter";
import { createLogger } from "../observability/logger";

const logger = createLogger("CustomerTimelineService");

export interface CustomerTimelineEventRecord {
  id: string;
  source: "ticket_events" | "conversation_events" | "conversation_handoffs";
  eventType: string;
  title: string;
  description: string;
  timestamp: string;
  createdAt: string;
  ticketId: string | null;
  conversationId: string | null;
}

export class CustomerTimelineService {
  private pool: any;

  constructor(customPool?: any) {
    this.pool = customPool || pool;
  }

  /**
   * Retrieves authoritative lifecycle events for a customer strictly scoped to authorized projects.
   */
  async getCustomerTimeline(
    customerIdentifier: string,
    projectIds: number[] | null,
    limit: number = 30,
    offset: number = 0
  ): Promise<CustomerTimelineEventRecord[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    const boundedOffset = Math.max(offset, 0);

    try {
      // Find all conversations belonging to this customer within authorized projects
      // Customer identifier can be: profile_id (number), customers.id (number), or LINE user ID (channel_ref)
      const convsSql = `
        SELECT c.id, c.project_id
        FROM conversations c
        LEFT JOIN identities i ON i.id = c.identity_id
        WHERE (
          c.customer = $1::text
          OR i.channel_ref = $1::text
          OR (i.profile_id IS NOT NULL AND i.profile_id = NULLIF(regexp_replace($1::text, '[^0-9]', '', 'g'), '')::integer)
          OR c.id IN (
            SELECT conversation_id FROM tickets 
            WHERE customer_id = NULLIF(regexp_replace($1::text, '[^0-9]', '', 'g'), '')::integer
          )
        )
        AND ($2::integer[] IS NULL OR c.project_id = ANY($2::integer[]))
        AND c.deleted_at IS NULL
      `;

      const convsRes = await this.pool.query(convsSql, [customerIdentifier, projectIds]);
      const convIds: number[] = convsRes.rows.map((r: any) => Number(r.id)).filter(Number.isInteger);

      if (convIds.length === 0) {
        return [];
      }

      // Query ticket_events, conversation_events, and conversation_handoffs in a single UNION
      const timelineSql = `
        WITH target_tickets AS (
          SELECT t.id, t.conversation_id, t.ticket_id AS ticket_code, t.subject
          FROM tickets t
          WHERE t.conversation_id = ANY($1::integer[])
            AND ($2::integer[] IS NULL OR t.project_id = ANY($2::integer[]))
            AND t.deleted_at IS NULL
        )
        SELECT 
          CONCAT('te-', te.id) AS id,
          'ticket_events' AS source,
          te.event_type,
          te.ticket_id::text AS ticket_id,
          tt.conversation_id::text AS conversation_id,
          tt.ticket_code,
          tt.subject,
          te.payload,
          te.created_at
        FROM ticket_events te
        JOIN target_tickets tt ON tt.id = te.ticket_id

        UNION ALL

        SELECT 
          CONCAT('ce-', ce.id) AS id,
          'conversation_events' AS source,
          ce.event_type,
          NULL::text AS ticket_id,
          ce.conversation_id::text AS conversation_id,
          NULL::text AS ticket_code,
          NULL::text AS subject,
          ce.payload,
          ce.created_at
        FROM conversation_events ce
        WHERE ce.conversation_id = ANY($1::integer[])

        UNION ALL

        SELECT 
          CONCAT('ch-', ch.id) AS id,
          'conversation_handoffs' AS source,
          CONCAT('HANDOFF_', UPPER(ch.trigger_type)) AS event_type,
          ch.ticket_id::text AS ticket_id,
          ch.conversation_id::text AS conversation_id,
          NULL::text AS ticket_code,
          ch.reason AS subject,
          jsonb_build_object('from_owner', ch.from_owner, 'to_owner', ch.to_owner, 'reason', ch.reason) AS payload,
          ch.started_at AS created_at
        FROM conversation_handoffs ch
        WHERE ch.conversation_id = ANY($1::integer[])
          AND ($2::integer[] IS NULL OR ch.project_id = ANY($2::integer[]))

        ORDER BY created_at DESC
        LIMIT $3::integer OFFSET $4::integer
      `;

      const result = await this.pool.query(timelineSql, [convIds, projectIds, boundedLimit, boundedOffset]);

      return result.rows.map((row: any) => {
        const createdAtIso = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
        const { title, description } = this.formatTimelineContent(row);

        return {
          id: String(row.id),
          source: row.source,
          eventType: row.event_type,
          title,
          description,
          timestamp: this.formatRelativeTime(row.created_at),
          createdAt: createdAtIso,
          ticketId: row.ticket_id || null,
          conversationId: row.conversation_id || null,
        };
      });
    } catch (err: any) {
      logger.error({ error: err.message, customerIdentifier }, "Failed to fetch customer timeline from PostgreSQL");
      return [];
    }
  }

  private formatTimelineContent(row: any): { title: string; description: string } {
    const eventType = String(row.event_type || "").toUpperCase();

    if (row.source === "ticket_events") {
      const ticketRef = row.ticket_code ? `#${row.ticket_code}` : `#${row.ticket_id}`;
      if (eventType.includes("CREATE")) {
        return {
          title: `Ticket ${ticketRef} Created`,
          description: row.subject ? `Subject: ${row.subject}` : "Support ticket opened for customer inquiry",
        };
      }
      if (eventType.includes("CLOSE") || eventType.includes("RESOLVE")) {
        return {
          title: `Ticket ${ticketRef} Closed / Resolved`,
          description: row.payload?.reason || "Ticket lifecycle marked complete",
        };
      }
      if (eventType.includes("REOPEN")) {
        return {
          title: `Ticket ${ticketRef} Reopened`,
          description: "Customer replied after resolution or issue reopened",
        };
      }
      return {
        title: `Ticket ${ticketRef} Updated`,
        description: `Lifecycle event: ${row.event_type}`,
      };
    }

    if (row.source === "conversation_handoffs") {
      const from = row.payload?.from_owner?.toUpperCase() || "AI";
      const to = row.payload?.to_owner?.toUpperCase() || "HUMAN";
      return {
        title: `Ownership Handoff: ${from} → ${to}`,
        description: row.payload?.reason || "Conversation control transitioned",
      };
    }

    // conversation_events
    if (eventType.includes("START") || eventType.includes("CREATED")) {
      return {
        title: `Conversation Session #${row.conversation_id} Started`,
        description: "Customer initiated inquiry via messaging channel",
      };
    }
    return {
      title: `Conversation Event: ${row.event_type}`,
      description: `Session #${row.conversation_id} state transition`,
    };
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

export const customerTimelineService = new CustomerTimelineService();
