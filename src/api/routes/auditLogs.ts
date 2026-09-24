import { FastifyInstance } from "fastify";
import { resolveProjectFilter } from "../../middleware/tenantScope";
import { auditService } from "../../services/AuditService";

export async function registerAuditLogsRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/admin/audit-logs
  fastify.get("/api/admin/audit-logs", async (request, reply) => {
    const query = (request.query || {}) as {
      projectId?: string;
      action?: string;
      operatorId?: string;
      limit?: string;
      offset?: string;
    };

    const filter = resolveProjectFilter(request, reply, query.projectId);
    if (!filter) return;

    const limit = Math.min(Math.max(parseInt(query.limit || "25", 10) || 25, 1), 100);
    const offset = Math.max(parseInt(query.offset || "0", 10) || 0, 0);

    const operatorId = query.operatorId && /^[0-9]+$/.test(query.operatorId) ? parseInt(query.operatorId, 10) : undefined;

    const result = await auditService.queryLogs({
      projectIds: filter.projectIds,
      action: query.action,
      operatorId,
      limit,
      offset,
    });

    return reply.send({
      success: true,
      logs: result.logs,
      total: result.total,
      limit,
      offset,
    });
  });
}
