import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveProjectFilter, canAccessProject } from "../../middleware/tenantScope";
import { CustomerIntelligenceService } from "../../services/CustomerIntelligenceService";
import { DailyIntelligenceService } from "../../services/DailyIntelligenceService";
import { KnowledgeGapService } from "../../services/KnowledgeGapService";
import { ConversationSummaryService } from "../../services/ConversationSummaryService";
import { ConversationNotFoundError } from "../../services/ConversationContextBuilder";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { createLogger } from "../../observability/logger";

const logger = createLogger("conversation-intelligence-api");

/**
 * Resolves a conversation's project from the database and checks it against
 * the caller's server-side tenant scope. Client-supplied project ids and
 * headers are never used for the decision. Replies 400/403/404 itself and
 * returns null when access is refused.
 */
async function authorizeConversation(
  request: FastifyRequest,
  reply: FastifyReply,
  rawId: string | undefined,
  db: any = pool
): Promise<{ conversationId: number; projectId: number } | null> {
  const conversationId = Number(rawId);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    reply.status(400).send({ error: "Bad Request", message: "A valid positive conversation id is required" });
    return null;
  }
  const res = await db.query(
    `SELECT project_id FROM conversations WHERE id = $1 AND deleted_at IS NULL LIMIT 1;`,
    [conversationId]
  );
  const projectId = res.rows[0]?.project_id != null ? Number(res.rows[0].project_id) : null;
  if (projectId === null) {
    reply.status(404).send({ error: "Not Found", message: `Conversation ${conversationId} not found` });
    return null;
  }
  if (!canAccessProject(request, projectId)) {
    // Same answer whether or not the conversation exists elsewhere.
    reply.status(403).send({ error: "Forbidden", message: "Access to this conversation is not authorized" });
    return null;
  }
  return { conversationId, projectId };
}

export async function registerConversationIntelligenceRoutes(
  fastify: FastifyInstance,
  deps: { pool?: any; summaryService?: ConversationSummaryService } = {}
): Promise<void> {
  const customerService = new CustomerIntelligenceService();
  const dailyService = new DailyIntelligenceService();
  const db = deps.pool || pool;
  const knowledgeGapService = new KnowledgeGapService(db);
  const summaryService = deps.summaryService || new ConversationSummaryService({ pool: db });

  // 0a. GET /api/admin/conversations/:id/ai-summary
  // Returns the stored AI summary with authoritative facts and staleness.
  // Never waits on the model: a missing or stale summary is regenerated in
  // the background and the response says so (refreshing: true).
  fastify.get("/api/admin/conversations/:id/ai-summary", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authorizeConversation(request, reply, (request.params as { id?: string }).id, db);
    if (!auth) return;
    try {
      const view = await summaryService.getSummary(auth.projectId, auth.conversationId);
      let refreshing = false;
      if ((view.stale || !view.summary) && view.status !== "generating" && view.facts.messageCount > 0) {
        refreshing = true;
        void summaryService.refresh(auth.projectId, auth.conversationId).catch((err: any) => {
          logger.warn({ error: err.message, conversationId: auth.conversationId }, "Background summary refresh failed");
        });
      }
      return reply.send({
        success: true,
        ...view,
        status: refreshing ? "generating" : view.status,
        refreshing,
        botContext: summaryService.toBotContext(view),
      });
    } catch (err: any) {
      if (err instanceof ConversationNotFoundError) {
        return reply.status(404).send({ error: "Not Found", message: `Conversation ${auth.conversationId} not found` });
      }
      logger.error({ error: err.message, conversationId: auth.conversationId }, "Failed to load conversation summary");
      return reply.status(500).send({ error: "Internal Server Error", message: "Conversation summary is unavailable" });
    }
  });

  // 0b. POST /api/admin/conversations/:id/ai-summary/refresh
  // Operator-requested regeneration; waits for the result.
  fastify.post("/api/admin/conversations/:id/ai-summary/refresh", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authorizeConversation(request, reply, (request.params as { id?: string }).id, db);
    if (!auth) return;
    try {
      const view = await summaryService.refresh(auth.projectId, auth.conversationId, { force: true });
      return reply.send({ success: true, ...view, refreshing: false, botContext: summaryService.toBotContext(view) });
    } catch (err: any) {
      if (err instanceof ConversationNotFoundError) {
        return reply.status(404).send({ error: "Not Found", message: `Conversation ${auth.conversationId} not found` });
      }
      logger.error({ error: err.message, conversationId: auth.conversationId }, "Failed to refresh conversation summary");
      return reply.status(500).send({ error: "Internal Server Error", message: "Conversation summary is unavailable" });
    }
  });

  // 1. GET /api/admin/intelligence/daily
  fastify.get("/api/admin/intelligence/daily", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.query || {}) as {
      projectId?: string;
      date?: string;
      fromDate?: string;
      toDate?: string;
    };

    const filter = resolveProjectFilter(request, reply, query.projectId);
    if (!filter) return;

    try {
      // Case A: Date range query across authorized projects
      if (query.fromDate && query.toDate) {
        const fromD = query.fromDate.slice(0, 10);
        const toD = query.toDate.slice(0, 10);
        const rollups = await dailyService.getDailyRollupsRange(filter.projectIds, fromD, toD);
        return reply.send({
          success: true,
          rollups,
          count: rollups.length,
        });
      }

      // Case B: Single date query for a single project
      const targetDate = query.date ? query.date.slice(0, 10) : new Date().toISOString().slice(0, 10);

      // If specific project requested and allowed
      if (filter.projectIds !== null && filter.projectIds.length === 1) {
        const pId = filter.projectIds[0];
        const record = await dailyService.getDailyIntelligence(pId, targetDate);
        return reply.send({
          success: true,
          daily: record,
        });
      }

      // If multi-project or super-admin with all projects
      const rollups = await dailyService.getDailyRollupsRange(filter.projectIds, targetDate, targetDate);
      return reply.send({
        success: true,
        rollups,
        count: rollups.length,
      });
    } catch (err: any) {
      logger.error({ error: err.message, query }, "Failed to fetch daily intelligence");
      return reply.status(500).send({ error: "Internal Server Error", message: err.message });
    }
  });

  // 2. POST /api/admin/intelligence/daily/calculate
  fastify.post("/api/admin/intelligence/daily/calculate", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body || {}) as {
      projectId?: number | string;
      date?: string;
      generateNarrative?: boolean;
    };

    const targetProjectId = Number(body.projectId);
    if (!Number.isInteger(targetProjectId) || targetProjectId <= 0) {
      return reply.status(400).send({ error: "Bad Request", message: "A valid positive projectId is required" });
    }

    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      return reply.status(400).send({ error: "Bad Request", message: "A valid date in YYYY-MM-DD format is required" });
    }

    // Verify authorized access to target project
    if (!canAccessProject(request, targetProjectId)) {
      return reply.status(403).send({ error: "Forbidden", message: `Access to project ${targetProjectId} is not authorized` });
    }

    try {
      const record = await dailyService.calculateDailyRollup(targetProjectId, body.date, {
        generateNarrative: body.generateNarrative === true,
      });
      return reply.send({
        success: true,
        daily: record,
      });
    } catch (err: any) {
      logger.error({ error: err.message, body }, "Failed to calculate daily intelligence");
      return reply.status(500).send({ error: "Internal Server Error", message: err.message });
    }
  });

  // 3. GET /api/admin/intelligence/customers/:id
  fastify.get("/api/admin/intelligence/customers/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { id: string };
    const customerIdentifier = params.id?.trim();
    if (!customerIdentifier) {
      return reply.status(400).send({ error: "Bad Request", message: "Customer identifier is required" });
    }

    const query = (request.query || {}) as { projectId?: string };
    const filter = resolveProjectFilter(request, reply, query.projectId);
    if (!filter) return;

    try {
      const intel = await customerService.getCustomerIntelligence(customerIdentifier, filter.projectIds);
      if (!intel) {
        return reply.status(403).send({
          error: "Forbidden",
          message: "Access to this customer record is not authorized within current project scope",
        });
      }

      return reply.send({
        success: true,
        intelligence: intel,
      });
    } catch (err: any) {
      logger.error({ error: err.message, customerIdentifier }, "Failed to retrieve customer intelligence");
      return reply.status(500).send({ error: "Internal Server Error", message: err.message });
    }
  });

  // 4. GET /api/admin/intelligence/knowledge-gaps/candidates
  fastify.get("/api/admin/intelligence/knowledge-gaps/candidates", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.query || {}) as {
      projectId?: string;
      status?: string;
      clusterId?: string;
      limit?: string;
      offset?: string;
    };

    const filter = resolveProjectFilter(request, reply, query.projectId);
    if (!filter) return;

    const targetProjectId = query.projectId
      ? Number(query.projectId)
      : filter.projectIds && filter.projectIds.length === 1
      ? filter.projectIds[0]
      : null;

    if (!targetProjectId || isNaN(targetProjectId) || targetProjectId <= 0) {
      return reply.status(400).send({ error: "Bad Request", message: "A specific valid projectId query parameter is required" });
    }

    if (!canAccessProject(request, targetProjectId)) {
      return reply.status(403).send({ error: "Forbidden", message: `Access to project ${targetProjectId} is not authorized` });
    }

    try {
      const { candidates, total } = await knowledgeGapService.getCandidates(targetProjectId, {
        status: query.status,
        clusterId: query.clusterId,
        limit: query.limit ? Number(query.limit) : undefined,
        offset: query.offset ? Number(query.offset) : undefined,
      });

      return reply.send({
        success: true,
        candidates,
        total,
      });
    } catch (err: any) {
      logger.error({ error: err.message, query }, "Failed to fetch knowledge gap candidates");
      return reply.status(500).send({ error: "Internal Server Error", message: err.message });
    }
  });

  // 5. PATCH /api/admin/intelligence/knowledge-gaps/candidates/:id/status
  fastify.patch("/api/admin/intelligence/knowledge-gaps/candidates/:id/status", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { id: string };
    const candidateId = Number(params.id);
    if (!Number.isInteger(candidateId) || candidateId <= 0) {
      return reply.status(400).send({ error: "Bad Request", message: "A valid positive candidate ID is required" });
    }

    const body = (request.body || {}) as {
      status?: string;
      reviewNotes?: string;
    };

    const validStatuses = ["open", "reviewed", "resolved", "ignored"];
    if (!body.status || !validStatuses.includes(body.status)) {
      return reply.status(400).send({
        error: "Bad Request",
        message: `status must be one of: ${validStatuses.join(", ")}`,
      });
    }

    // Authorization comes from the server-resolved tenant scope. `request.user`
    // is never populated by authHook, so reading it denied every caller.
    const scope = request.tenantScope;
    if (!scope) {
      return reply.status(403).send({ error: "Forbidden", message: "No tenant scope is associated with this request" });
    }
    const authorizedProjects: number[] | null = scope.unrestricted ? null : scope.projectIds;
    const reviewerName = request.principal?.email || request.principal?.subject || "operator";

    try {
      const updated = await knowledgeGapService.updateCandidateStatus(
        candidateId,
        body.status as any,
        body.reviewNotes,
        reviewerName,
        authorizedProjects
      );

      if (!updated) {
        return reply.status(404).send({ error: "Not Found", message: `Candidate ${candidateId} not found` });
      }

      return reply.send({
        success: true,
        candidate: updated,
      });
    } catch (err: any) {
      if (err.message && err.message.startsWith("Unauthorized")) {
        return reply.status(403).send({ error: "Forbidden", message: err.message });
      }
      logger.error({ error: err.message, candidateId, body }, "Failed to update candidate status");
      return reply.status(500).send({ error: "Internal Server Error", message: err.message });
    }
  });

  // 6. GET /api/admin/intelligence/knowledge-gaps/clusters
  fastify.get("/api/admin/intelligence/knowledge-gaps/clusters", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.query || {}) as {
      projectId?: string;
      limit?: string;
      offset?: string;
    };

    const filter = resolveProjectFilter(request, reply, query.projectId);
    if (!filter) return;

    const targetProjectId = query.projectId
      ? Number(query.projectId)
      : filter.projectIds && filter.projectIds.length === 1
      ? filter.projectIds[0]
      : null;

    if (!targetProjectId || isNaN(targetProjectId) || targetProjectId <= 0) {
      return reply.status(400).send({ error: "Bad Request", message: "A specific valid projectId query parameter is required" });
    }

    if (!canAccessProject(request, targetProjectId)) {
      return reply.status(403).send({ error: "Forbidden", message: `Access to project ${targetProjectId} is not authorized` });
    }

    try {
      const { clusters, total } = await knowledgeGapService.getClusters(targetProjectId, {
        limit: query.limit ? Number(query.limit) : undefined,
        offset: query.offset ? Number(query.offset) : undefined,
      });

      return reply.send({
        success: true,
        clusters,
        total,
      });
    } catch (err: any) {
      logger.error({ error: err.message, query }, "Failed to fetch knowledge gap clusters");
      return reply.status(500).send({ error: "Internal Server Error", message: err.message });
    }
  });

  // 7. POST /api/admin/intelligence/knowledge-gaps/clusters/run
  fastify.post("/api/admin/intelligence/knowledge-gaps/clusters/run", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body || {}) as {
      projectId?: number | string;
    };

    const targetProjectId = Number(body.projectId);
    if (!Number.isInteger(targetProjectId) || targetProjectId <= 0) {
      return reply.status(400).send({ error: "Bad Request", message: "A valid positive projectId is required" });
    }

    if (!canAccessProject(request, targetProjectId)) {
      return reply.status(403).send({ error: "Forbidden", message: `Access to project ${targetProjectId} is not authorized` });
    }

    try {
      const result = await knowledgeGapService.runClusteringForProject(targetProjectId);
      return reply.send({
        success: true,
        clustersCreated: result.clustersCreated,
        clusters: result.clusters,
        // "lexical_only" when no real embeddings were available (mock provider).
        similarityBasis: result.similarityBasis,
      });
    } catch (err: any) {
      logger.error({ error: err.message, body }, "Failed to run knowledge gap clustering");
      return reply.status(500).send({ error: "Internal Server Error", message: err.message });
    }
  });
}
