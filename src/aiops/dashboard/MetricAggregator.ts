import { DatabaseAdapter } from "../../adapters/types";
import { ConversationTraceSummary, HandoffNode } from "../../schemas/aiops";
import { AuditLog } from "../../schemas/validation";
import { createLogger } from "../../observability/logger";

const logger = createLogger("MetricAggregator");

export class MetricAggregator {
  private dbAdapter: DatabaseAdapter;

  constructor(dbAdapter: DatabaseAdapter) {
    this.dbAdapter = dbAdapter;
  }

  async getDashboardMetrics(tenantId?: string) {
    const allTraces = await this.dbAdapter.listAllTraces();
    const allTickets = await this.dbAdapter.listAllTickets();

    // Map conversationId -> companyId (tenantId)
    const convToCompany = new Map<string, string>();

    // Warm up the cache
    for (const trace of allTraces) {
      const convId = trace.conversationId;
      if (convId && !convToCompany.has(convId)) {
        try {
          const conv = await this.dbAdapter.getConversation(convId);
          if (conv) {
            let companyId = String(conv.company_id || conv.companyId || "");
            if (!companyId && (conv.project_id || conv.project)) {
              const project = await this.dbAdapter.findProject(conv.project_id || conv.project);
              if (project) {
                companyId = String(project.company_id || project.companyId || "");
              }
            }
            convToCompany.set(convId, companyId);
          }
        } catch {}
      }
    }

    // Warm up cache with ticket conversations too
    for (const ticket of allTickets) {
      const convId = ticket.conversationId || ticket.conversation_id || ticket.conversation;
      if (convId && !convToCompany.has(convId)) {
        try {
          const conv = await this.dbAdapter.getConversation(convId);
          if (conv) {
            let companyId = String(conv.company_id || conv.companyId || "");
            if (!companyId && (conv.project_id || conv.project)) {
              const project = await this.dbAdapter.findProject(conv.project_id || conv.project);
              if (project) {
                companyId = String(project.company_id || project.companyId || "");
              }
            }
            convToCompany.set(convId, companyId);
          }
        } catch {}
      }
    }

    // Filter traces by tenantId
    const filteredTraces = tenantId
      ? allTraces.filter((t) => t.conversationId && convToCompany.get(t.conversationId) === tenantId)
      : allTraces;

    // Filter tickets by tenantId
    const filteredTickets = tenantId
      ? allTickets.filter((t) => {
          const cId =
            t.companyId ||
            t.company_id ||
            (t.conversationId && convToCompany.get(t.conversationId)) ||
            (t.conversation_id && convToCompany.get(t.conversation_id)) ||
            (t.conversation && convToCompany.get(t.conversation));
          return String(cId) === tenantId;
        })
      : allTickets;

    // Calculate Latencies
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

    // SLA Violations
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

    // Agent Routing Distributions
    const agentRoutingDist: Record<string, number> = {};
    for (const trace of filteredTraces) {
      if (trace.agentId) {
        agentRoutingDist[trace.agentId] = (agentRoutingDist[trace.agentId] || 0) + 1;
      }
    }

    // Fetch Cache Metrics
    const cacheService = require("../../cache/CacheService").CacheService.getInstance();
    const cacheMetrics = cacheService.getMetrics();
    let totalHits = 0;
    let totalMisses = 0;
    for (const tenantKey of Object.keys(cacheMetrics)) {
      totalHits += cacheMetrics[tenantKey].hits || 0;
      totalMisses += cacheMetrics[tenantKey].misses || 0;
    }
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

  async getConversationTraceSummaries(tenantId?: string): Promise<ConversationTraceSummary[]> {
    const allTraces = await this.dbAdapter.listAllTraces();

    // Group traces by conversationId
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

    for (const [convId, traces] of tracesByConv.entries()) {
      // Load conversation for tenant checks
      let companyId = "";
      try {
        const conv = await this.dbAdapter.getConversation(convId);
        if (conv) {
          companyId = String(conv.company_id || conv.companyId || "");
          if (!companyId && (conv.project_id || conv.project)) {
            const project = await this.dbAdapter.findProject(conv.project_id || conv.project);
            if (project) {
              companyId = String(project.company_id || project.companyId || "");
            }
          }
        }
      } catch {}

      if (tenantId && companyId !== tenantId) {
        continue; // Skip if filtered out
      }

      // Reconstruct handoff chain
      // Filter for HANDOFF traces and sort by calledAt
      const handoffTraces = traces
        .filter((t) => t.status === "HANDOFF")
        .sort((a, b) => new Date(a.calledAt).getTime() - new Date(b.calledAt).getTime());

      const handoffChain: HandoffNode[] = handoffTraces.map((t) => {
        // extract destination agent from arguments
        const toAgent = t.arguments?.toAgentId || t.toolName || "unknown";
        return {
          agentId: toAgent,
          timestamp: t.calledAt,
          reason: t.reason,
        };
      });

      // Find overall status and start/end times
      const startTimes = traces.map((t) => new Date(t.calledAt).getTime());
      const endTimes = traces.filter((t) => t.completedAt).map((t) => new Date(t.completedAt!).getTime());

      const startTime =
        startTimes.length > 0 ? new Date(Math.min(...startTimes)).toISOString() : new Date().toISOString();
      const endTime = endTimes.length > 0 ? new Date(Math.max(...endTimes)).toISOString() : undefined;
      const durationMs =
        startTimes.length > 0 && endTimes.length > 0 ? Math.max(...endTimes) - Math.min(...startTimes) : undefined;

      // Determine overall status
      let status: "RUNNING" | "COMPLETED" | "FAILED" | "HANDOFF" = "RUNNING";
      if (traces.some((t) => t.status === "FAILED")) {
        status = "FAILED";
      } else if (traces.some((t) => t.status === "COMPLETED")) {
        status = "COMPLETED";
      } else if (traces.some((t) => t.status === "HANDOFF")) {
        status = "HANDOFF";
      }

      // Check SLA breaches
      // Let's see if there are any tickets for this conversation that are violated
      const conversationTickets = await this.dbAdapter.listAllTickets().then((tcks) =>
        tcks.filter((t) => {
          const cId = t.conversationId || t.conversation_id || t.conversation;
          return String(cId) === convId;
        })
      );
      const slaViolated = conversationTickets.some((t) => {
        const dueDate = t.dueDate || t.due_date;
        return t.status !== "Resolved" && dueDate && new Date() > new Date(dueDate);
      });

      summaries.push({
        conversationId: convId,
        tenantId: companyId,
        startTime,
        endTime,
        durationMs,
        handoffChain,
        status,
        slaViolated,
      });
    }

    return summaries;
  }
}
