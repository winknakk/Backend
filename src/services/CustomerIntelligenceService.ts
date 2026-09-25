import { pool } from "../adapters/postgres/PostgresAdapter";
import { createLogger } from "../observability/logger";

const logger = createLogger("CustomerIntelligenceService");

export interface CustomerIntelligenceResult {
  customerId: string;
  projectIds: number[];
  totalConversations: number;
  totalTickets: number;
  resolvedTickets: number;
  reopenedTickets: number;
  handoffCount: number;
  slaBreaches: number;
  frictionRatio: number;
  resolutionEfficiency: number;
  repeatProblemCount: number;
  channelDistribution: Record<string, number>;
  lastActivityAt: string | null;
}

export class CustomerIntelligenceService {
  private pool: any;

  constructor(customPool?: any) {
    this.pool = customPool || pool;
  }

  /**
   * Authoritatively computes deterministic customer operational metrics strictly bounded
   * to authorized projects. Zero speculative churn or psychological profiling.
   */
  async getCustomerIntelligence(
    customerIdentifier: string,
    authorizedProjectIds: number[] | null
  ): Promise<CustomerIntelligenceResult | null> {
    try {
      // 1. Resolve conversations for this customer within authorized projects
      const convsSql = `
        SELECT c.id, c.project_id, c.channel, c.status, c.handled_by, c.takeover_state,
               c.created_at, c.last_message_at
        FROM conversations c
        LEFT JOIN identities i ON i.id::text = c.identity_id::text
        WHERE (
          i.channel_ref = $1::text
          OR i.id::text = $1::text
          OR (i.profile_id IS NOT NULL AND i.profile_id::text = $1::text)
          OR c.identity_id::text = $1::text
        )
        AND ($2::integer[] IS NULL OR c.project_id = ANY($2::integer[]))
        AND c.deleted_at IS NULL
        ORDER BY c.created_at DESC
      `;

      const convsRes = await this.pool.query(convsSql, [customerIdentifier, authorizedProjectIds]);
      const convRows = convsRes.rows;
      const convIds: number[] = convRows.map((r: any) => Number(r.id)).filter(Number.isInteger);

      // If no conversations found, check whether customer exists in unauthorized project (for security auditing)
      if (convIds.length === 0) {
        const anyProjectSql = `
          SELECT c.project_id
          FROM conversations c
          LEFT JOIN identities i ON i.id::text = c.identity_id::text
          WHERE (
            i.channel_ref = $1::text
            OR i.id::text = $1::text
            OR (i.profile_id IS NOT NULL AND i.profile_id::text = $1::text)
            OR c.identity_id::text = $1::text
          )
          AND c.deleted_at IS NULL
          LIMIT 1
        `;
        const crossCheck = await this.pool.query(anyProjectSql, [customerIdentifier]);
        if (crossCheck.rows.length > 0 && authorizedProjectIds !== null && !authorizedProjectIds.includes(crossCheck.rows[0].project_id)) {
          // Exists in a foreign project that the operator is not authorized for
          logger.warn(
            { customerIdentifier, targetProject: crossCheck.rows[0].project_id, authorized: authorizedProjectIds },
            "Cross-project customer access attempt denied"
          );
          return null;
        }

        // Return clean zero-denominator metrics for customer with 0 conversations
        return {
          customerId: customerIdentifier,
          projectIds: authorizedProjectIds || [],
          totalConversations: 0,
          totalTickets: 0,
          resolvedTickets: 0,
          reopenedTickets: 0,
          handoffCount: 0,
          slaBreaches: 0,
          frictionRatio: 0.0,
          resolutionEfficiency: 0.0,
          repeatProblemCount: 0,
          channelDistribution: {},
          lastActivityAt: null,
        };
      }

      // 2. Query tickets for these conversations (ordered chronologically for 30-day window detection)
      const ticketsSql = `
        SELECT id, conversation_id, project_id, status, reopened_count, sla_breached,
               duplicate_of_ticket_id, issue_category, created_at, resolved_at, closed_at
        FROM tickets
        WHERE conversation_id = ANY($1::integer[])
          AND ($2::integer[] IS NULL OR project_id = ANY($2::integer[]))
          AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC
      `;
      const ticketsRes = await this.pool.query(ticketsSql, [convIds, authorizedProjectIds]);
      const ticketRows = ticketsRes.rows;

      // 3. Query handoffs for these conversations
      const handoffsSql = `
        SELECT count(*)::integer AS handoff_count
        FROM conversation_handoffs
        WHERE conversation_id = ANY($1::integer[])
          AND ($2::integer[] IS NULL OR project_id = ANY($2::integer[]))
      `;
      const handoffsRes = await this.pool.query(handoffsSql, [convIds, authorizedProjectIds]);
      const handoffCount = Number(handoffsRes.rows[0]?.handoff_count || 0);

      // 4. Deterministic computation
      const totalConversations = convRows.length;
      const totalTickets = ticketRows.length;

      let resolvedTickets = 0;
      let reopenedTickets = 0;
      let slaBreaches = 0;
      let repeatProblemCount = 0;

      const RESOLVED_STATUSES = new Set([
        "resolved",
        "closed",
        "customer_confirmed",
        "Resolved",
        "Closed",
        "RESOLVED",
        "CLOSED",
        "CUSTOMER_CONFIRMED",
      ]);

      // 30-day window in milliseconds
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      // Map of "projectId:normalizedCategory" -> array of ticket creation timestamps (ms)
      const categoryHistory = new Map<string, number[]>();

      for (const t of ticketRows) {
        if (RESOLVED_STATUSES.has(String(t.status))) {
          resolvedTickets++;
        }
        if (Number(t.reopened_count || 0) > 0 || String(t.status).toUpperCase() === "REOPENED") {
          reopenedTickets++;
        }
        if (Boolean(t.sla_breached)) {
          slaBreaches++;
        }

        // Authoritative repeat problem contract:
        // duplicate_of_ticket_id IS NOT NULL OR recurring issue_category within 30 days
        const currentCreatedAt = new Date(t.created_at).getTime();
        let isRepeatProblem = false;

        if (t.duplicate_of_ticket_id !== null && t.duplicate_of_ticket_id !== undefined) {
          isRepeatProblem = true;
        } else if (t.issue_category && typeof t.issue_category === "string" && t.issue_category.trim().length > 0) {
          const categoryKey = `${t.project_id}:${t.issue_category.trim().toLowerCase()}`;
          const priorTimestamps = categoryHistory.get(categoryKey) || [];
          const hasPriorInWindow = priorTimestamps.some(
            (prevTime) => currentCreatedAt >= prevTime && (currentCreatedAt - prevTime) <= THIRTY_DAYS_MS
          );
          if (hasPriorInWindow) {
            isRepeatProblem = true;
          }
        }

        if (isRepeatProblem) {
          repeatProblemCount++;
        }

        // Record timestamp for subsequent recurring category detection
        if (t.issue_category && typeof t.issue_category === "string" && t.issue_category.trim().length > 0) {
          const categoryKey = `${t.project_id}:${t.issue_category.trim().toLowerCase()}`;
          const list = categoryHistory.get(categoryKey) || [];
          list.push(currentCreatedAt);
          categoryHistory.set(categoryKey, list);
        }
      }

      // Zero-denominator safe formulas
      const frictionRatio = totalConversations > 0
        ? Number(((handoffCount + reopenedTickets) / totalConversations).toFixed(4))
        : 0.0;

      const resolutionEfficiency = totalTickets > 0
        ? Number((resolvedTickets / totalTickets).toFixed(4))
        : 0.0;

      // Channel breakdown
      const channelDistribution: Record<string, number> = {};
      let latestTimestamp: number = 0;

      for (const c of convRows) {
        const ch = String(c.channel || "unknown");
        channelDistribution[ch] = (channelDistribution[ch] || 0) + 1;

        const convTime = new Date(c.last_message_at || c.created_at).getTime();
        if (convTime > latestTimestamp) {
          latestTimestamp = convTime;
        }
      }

      for (const t of ticketRows) {
        const ticketTime = new Date(t.created_at).getTime();
        if (ticketTime > latestTimestamp) {
          latestTimestamp = ticketTime;
        }
      }

      const activeProjects = Array.from<number>(new Set(convRows.map((r: any) => Number(r.project_id))));

      return {
        customerId: customerIdentifier,
        projectIds: activeProjects,
        totalConversations,
        totalTickets,
        resolvedTickets,
        reopenedTickets,
        handoffCount,
        slaBreaches,
        frictionRatio,
        resolutionEfficiency,
        repeatProblemCount,
        channelDistribution,
        lastActivityAt: latestTimestamp > 0 ? new Date(latestTimestamp).toISOString() : null,
      };
    } catch (err: any) {
      logger.error({ error: err.message, customerIdentifier }, "Failed to compute customer intelligence");
      throw err;
    }
  }
}
