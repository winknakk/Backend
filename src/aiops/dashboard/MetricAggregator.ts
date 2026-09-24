import { DatabaseAdapter } from "../../adapters/types";
import { ConversationTraceSummary, HandoffNode } from "../../schemas/aiops";
import { AuditLog } from "../../schemas/validation";
import { createLogger } from "../../observability/logger";
import { pool } from "../../adapters/postgres/PostgresAdapter";

const logger = createLogger("MetricAggregator");

export class MetricAggregator {
  private dbAdapter: DatabaseAdapter;
  private pool: any;

  constructor(dbAdapter: DatabaseAdapter, customPool?: any) {
    this.dbAdapter = dbAdapter;
    this.pool = customPool || pool;
  }

  private normalizeProjectScope(scope?: string | number[] | null): number[] | null {
    if (scope === null) return null;
    if (Array.isArray(scope)) {
      return scope.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
    }
    if (typeof scope === "string") {
      const trimmed = scope.trim();
      if (!trimmed || trimmed.toLowerCase() === "all") return null;
      if (/^[0-9]+$/.test(trimmed)) {
        const parsed = parseInt(trimmed, 10);
        return parsed > 0 ? [parsed] : null;
      }
    }
    return null;
  }

  async getDashboardMetrics(projectScope?: string | number[] | null) {
    const projectIds = this.normalizeProjectScope(projectScope);

    // Try high-performance direct SQL execution first
    try {
      // 1. Traces metrics in a single pass
      const tracesSql = `
        SELECT 
          COUNT(*)::integer AS total_traces,
          COUNT(*) FILTER (WHERE t.status = 'COMPLETED')::integer AS completed_traces,
          COUNT(*) FILTER (WHERE t.status = 'FAILED')::integer AS failed_traces,
          COALESCE(AVG(
            CASE 
              WHEN t.completed_at IS NOT NULL AND t.called_at IS NOT NULL 
              THEN EXTRACT(EPOCH FROM (t.completed_at::timestamptz - t.called_at::timestamptz)) * 1000 
              ELSE NULL 
            END
          ) FILTER (WHERE t.status = 'COMPLETED'), 0)::numeric(10,2) AS average_latency_ms
        FROM traces t
        LEFT JOIN conversations c ON c.id = NULLIF(regexp_replace(t.conversation_id, '[^0-9]', '', 'g'), '')::integer
        WHERE ($1::integer[] IS NULL OR c.project_id = ANY($1::integer[]))
      `;

      // 2. Tickets metrics in a single pass
      const ticketsSql = `
        SELECT 
          COUNT(*)::integer AS total_tickets,
          COUNT(*) FILTER (
            WHERE t.status NOT IN ('Resolved', 'Closed', 'Cancelled', 'Done') 
              AND t.due_date IS NOT NULL 
              AND t.due_date < NOW()
          )::integer AS sla_violations
        FROM tickets t
        WHERE ($1::integer[] IS NULL OR t.project_id = ANY($1::integer[]))
          AND t.deleted_at IS NULL
      `;

      // 3. Agent distribution in a single pass
      const agentsSql = `
        SELECT 
          COALESCE(t.agent_id, 'unknown') AS agent_id,
          COUNT(*)::integer AS count
        FROM traces t
        LEFT JOIN conversations c ON c.id = NULLIF(regexp_replace(t.conversation_id, '[^0-9]', '', 'g'), '')::integer
        WHERE ($1::integer[] IS NULL OR c.project_id = ANY($1::integer[]))
          AND t.agent_id IS NOT NULL
        GROUP BY t.agent_id
      `;

      const [tracesRes, ticketsRes, agentsRes] = await Promise.all([
        this.pool.query(tracesSql, [projectIds]),
        this.pool.query(ticketsSql, [projectIds]),
        this.pool.query(agentsSql, [projectIds]),
      ]);

      const tRow = tracesRes.rows[0] || {};
      const tkRow = ticketsRes.rows[0] || {};

      const totalTraces = Number(tRow.total_traces || 0);
      const completedTraces = Number(tRow.completed_traces || 0);
      const failedTraces = Number(tRow.failed_traces || 0);
      const averageLatencyMs = parseFloat(tRow.average_latency_ms || "0");

      const totalTickets = Number(tkRow.total_tickets || 0);
      const slaViolations = Number(tkRow.sla_violations || 0);
      const slaViolationRate = totalTickets > 0 ? parseFloat((slaViolations / totalTickets).toFixed(4)) : 0;

      const agentRoutingDist: Record<string, number> = {};
      for (const row of agentsRes.rows) {
        if (row.agent_id) {
          agentRoutingDist[row.agent_id] = Number(row.count || 0);
        }
      }

      // Fetch Cache Metrics
      let totalHits = 0;
      let totalMisses = 0;
      let cacheMetrics = {};
      try {
        const cacheService = require("../../cache/CacheService").CacheService.getInstance();
        cacheMetrics = cacheService.getMetrics();
        for (const tenantKey of Object.keys(cacheMetrics)) {
          totalHits += (cacheMetrics as any)[tenantKey].hits || 0;
          totalMisses += (cacheMetrics as any)[tenantKey].misses || 0;
        }
      } catch {}
      const totalCache = totalHits + totalMisses;
      const cacheHitRatio = totalCache > 0 ? parseFloat((totalHits / totalCache).toFixed(2)) : 0;

      // Fetch Queue Depth
      let queueDepth = 0;
      try {
        const queueFactory = require("../../queue/QueueFactory").QueueFactory;
        const jobQueue = queueFactory.getQueue();
        if (jobQueue && typeof jobQueue.getQueueDepth === "function") {
          queueDepth = await jobQueue.getQueueDepth();
        }
      } catch (qErr: any) {
        logger.warn({ error: qErr.message }, "Failed to resolve live queue depth for dashboard metrics");
      }

      return {
        totalTraces,
        completedTraces,
        failedTraces,
        averageLatencyMs,
        totalTickets,
        slaViolations,
        slaViolationRate,
        agentRoutingDistribution: agentRoutingDist,
        queueDepth,
        cacheHits: totalHits,
        cacheMisses: totalMisses,
        cacheHitRatio,
        cacheMetrics,
      };
    } catch (sqlErr: any) {
      logger.warn({ error: sqlErr.message }, "SQL aggregation unavailable, executing bounded fallback aggregation");
      return this.fallbackDashboardMetrics(projectScope);
    }
  }

  private async fallbackDashboardMetrics(tenantId?: string | number[] | null) {
    const allTraces = (this.dbAdapter && typeof this.dbAdapter.listAllTraces === "function")
      ? await this.dbAdapter.listAllTraces()
      : [];
    const allTickets = (this.dbAdapter && typeof this.dbAdapter.listAllTickets === "function")
      ? await this.dbAdapter.listAllTickets()
      : [];

    const projectIds = this.normalizeProjectScope(tenantId);
    const tenantStr = typeof tenantId === "string" ? tenantId.toLowerCase() : null;
    const isAll = !tenantId || tenantStr === "all" || projectIds === null;

    // Filter traces by project or company
    const filteredTraces = isAll
      ? allTraces
      : allTraces.filter((t) => {
          if (!t.conversationId) return false;
          if (projectIds && projectIds.length > 0) {
            return true; // fallback best-effort
          }
          return true;
        });

    const filteredTickets = isAll
      ? allTickets
      : allTickets.filter((t) => {
          const pId = t.projectId || t.project_id || t.project;
          if (projectIds && projectIds.length > 0 && pId) {
            return projectIds.includes(Number(pId));
          }
          return true;
        });

    let totalLatencyMs = 0;
    let completedCount = 0;
    let failedCount = 0;

    for (const trace of filteredTraces) {
      if (trace.status === "COMPLETED" && trace.completedAt) {
        const start = new Date(trace.calledAt).getTime();
        const end = new Date(trace.completedAt).getTime();
        totalLatencyMs += Math.max(0, end - start);
        completedCount++;
      } else if (trace.status === "FAILED") {
        failedCount++;
      }
    }

    const averageLatencyMs = completedCount > 0 ? totalLatencyMs / completedCount : 0;

    const now = new Date();
    let slaViolations = 0;
    for (const ticket of filteredTickets) {
      const dueDate = ticket.dueDate || ticket.due_date;
      if (ticket.status !== "Resolved" && dueDate) {
        if (now > new Date(dueDate)) {
          slaViolations++;
        }
      }
    }

    const agentRoutingDist: Record<string, number> = {};
    for (const trace of filteredTraces) {
      if (trace.agentId) {
        agentRoutingDist[trace.agentId] = (agentRoutingDist[trace.agentId] || 0) + 1;
      }
    }

    let totalHits = 0;
    let totalMisses = 0;
    let cacheMetrics = {};
    try {
      const cacheService = require("../../cache/CacheService").CacheService.getInstance();
      cacheMetrics = cacheService.getMetrics();
      for (const tenantKey of Object.keys(cacheMetrics)) {
        totalHits += (cacheMetrics as any)[tenantKey].hits || 0;
        totalMisses += (cacheMetrics as any)[tenantKey].misses || 0;
      }
    } catch {}
    const totalCache = totalHits + totalMisses;
    const cacheHitRatio = totalCache > 0 ? parseFloat((totalHits / totalCache).toFixed(2)) : 0;

    let queueDepth = 0;
    try {
      const queueFactory = require("../../queue/QueueFactory").QueueFactory;
      const jobQueue = queueFactory.getQueue();
      if (jobQueue && typeof jobQueue.getQueueDepth === "function") {
        queueDepth = await jobQueue.getQueueDepth();
      }
    } catch {}

    return {
      totalTraces: filteredTraces.length,
      completedTraces: completedCount,
      failedTraces: failedCount,
      averageLatencyMs,
      totalTickets: filteredTickets.length,
      slaViolations,
      slaViolationRate: filteredTickets.length > 0 ? slaViolations / filteredTickets.length : 0,
      agentRoutingDistribution: agentRoutingDist,
      queueDepth,
      cacheHits: totalHits,
      cacheMisses: totalMisses,
      cacheHitRatio,
      cacheMetrics,
    };
  }

  async getConversationTraceSummaries(
    projectScope?: string | number[] | null,
    options?: { limit?: number; offset?: number }
  ): Promise<ConversationTraceSummary[]> {
    const projectIds = this.normalizeProjectScope(projectScope);
    const limit = Math.min(Math.max(Number(options?.limit) || 50, 1), 100);
    const offset = Math.max(Number(options?.offset) || 0, 0);

    try {
      const sql = `
        SELECT 
          c.id AS conversation_id,
          COALESCE(c.company_id::text, c.project_id::text, '') AS tenant_id,
          MIN(t.called_at) AS start_time,
          MAX(t.completed_at) AS end_time,
          EXTRACT(EPOCH FROM (MAX(COALESCE(t.completed_at, t.called_at)) - MIN(t.called_at))) * 1000 AS duration_ms,
          CASE 
            WHEN BOOL_OR(t.status = 'FAILED') THEN 'FAILED'
            WHEN BOOL_OR(t.status = 'COMPLETED') THEN 'COMPLETED'
            WHEN BOOL_OR(t.status = 'HANDOFF') THEN 'HANDOFF'
            ELSE 'RUNNING'
          END AS status,
          EXISTS (
            SELECT 1 FROM tickets tk 
            WHERE tk.conversation_id = c.id 
              AND tk.status NOT IN ('Resolved', 'Closed', 'Cancelled', 'Done') 
              AND tk.due_date IS NOT NULL 
              AND tk.due_date < NOW()
              AND tk.deleted_at IS NULL
          ) AS sla_violated,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'agentId', COALESCE(t.arguments->>'toAgentId', t.tool_name, 'unknown'),
                'timestamp', t.called_at,
                'reason', t.reason
              ) ORDER BY t.called_at ASC
            ) FILTER (WHERE t.status = 'HANDOFF'),
            '[]'::jsonb
          ) AS handoff_chain
        FROM traces t
        JOIN conversations c ON c.id = NULLIF(regexp_replace(t.conversation_id, '[^0-9]', '', 'g'), '')::integer
        WHERE ($1::integer[] IS NULL OR c.project_id = ANY($1::integer[]))
        GROUP BY c.id, c.company_id, c.project_id
        ORDER BY MIN(t.called_at) DESC
        LIMIT $2 OFFSET $3
      `;

      const result = await this.pool.query(sql, [projectIds, limit, offset]);

      return result.rows.map((row: any) => ({
        conversationId: String(row.conversation_id),
        tenantId: row.tenant_id,
        startTime: row.start_time instanceof Date ? row.start_time.toISOString() : String(row.start_time || new Date().toISOString()),
        endTime: row.end_time ? (row.end_time instanceof Date ? row.end_time.toISOString() : String(row.end_time)) : undefined,
        durationMs: row.duration_ms !== null ? Math.max(0, Math.round(Number(row.duration_ms))) : undefined,
        handoffChain: Array.isArray(row.handoff_chain) ? row.handoff_chain : [],
        status: row.status as "RUNNING" | "COMPLETED" | "FAILED" | "HANDOFF",
        slaViolated: Boolean(row.sla_violated),
      }));
    } catch (sqlErr: any) {
      logger.warn({ error: sqlErr.message }, "SQL trace summaries unavailable, using bounded fallback");
      return this.fallbackConversationTraceSummaries(projectScope, limit);
    }
  }

  private async fallbackConversationTraceSummaries(
    tenantId?: string | number[] | null,
    limit: number = 50
  ): Promise<ConversationTraceSummary[]> {
    const allTraces = await this.dbAdapter.listAllTraces();
    const tracesByConv = new Map<string, AuditLog[]>();

    for (const trace of allTraces) {
      const convId = trace.conversationId;
      if (convId) {
        if (!tracesByConv.has(convId)) {
          tracesByConv.set(convId, []);
        }
        tracesByConv.get(convId)!.push(trace);
      }
    }

    const summaries: ConversationTraceSummary[] = [];
    const entries = Array.from(tracesByConv.entries()).slice(0, limit);

    for (const [convId, traces] of entries) {
      const handoffTraces = traces
        .filter((t) => t.status === "HANDOFF")
        .sort((a, b) => new Date(a.calledAt).getTime() - new Date(b.calledAt).getTime());

      const handoffChain: HandoffNode[] = handoffTraces.map((t) => ({
        agentId: t.arguments?.toAgentId || t.toolName || "unknown",
        timestamp: t.calledAt,
        reason: t.reason,
      }));

      const startTimes = traces.map((t) => new Date(t.calledAt).getTime());
      const endTimes = traces.filter((t) => t.completedAt).map((t) => new Date(t.completedAt!).getTime());

      const startTime =
        startTimes.length > 0 ? new Date(Math.min(...startTimes)).toISOString() : new Date().toISOString();
      const endTime = endTimes.length > 0 ? new Date(Math.max(...endTimes)).toISOString() : undefined;
      const durationMs =
        startTimes.length > 0 && endTimes.length > 0 ? Math.max(...endTimes) - Math.min(...startTimes) : undefined;

      let status: "RUNNING" | "COMPLETED" | "FAILED" | "HANDOFF" = "RUNNING";
      if (traces.some((t) => t.status === "FAILED")) {
        status = "FAILED";
      } else if (traces.some((t) => t.status === "COMPLETED")) {
        status = "COMPLETED";
      } else if (traces.some((t) => t.status === "HANDOFF")) {
        status = "HANDOFF";
      }

      summaries.push({
        conversationId: convId,
        tenantId: "",
        startTime,
        endTime,
        durationMs,
        handoffChain,
        status,
        slaViolated: false,
      });
    }

    return summaries;
  }
}
