import { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config/env";
import { MetricAggregator } from "../../aiops/dashboard/MetricAggregator";
import { IngestionService } from "../../aiops/ragops/IngestionService";
import { EvalTestRunner } from "../../aiops/llmops/EvalTestRunner";
import { TrafficSplitter } from "../../aiops/prompt-control/TrafficSplitter";
import { authHook } from "../../middleware/auth";
import { DocumentIngestionPayloadSchema, AbTestWeightSchema, EvalTestCaseSchema } from "../../schemas/aiops";
import { DatabaseAdapter } from "../../adapters/types";
import { HumanReplyService } from "../../services/humanReplyService";
import { PlaneService } from "../../services/planeService";
import { TicketService } from "../../tools/TicketService";
import { TicketInputSchema } from "../../schemas/validation";
import { TakeoverManager } from "../../human-takeover/TakeoverManager";
import { ConversationMemoryService } from "../../memory/ConversationMemoryService";

export interface AdminRouteDependencies {
  metricAggregator: MetricAggregator;
  ingestionService: IngestionService;
  evalTestRunner: EvalTestRunner;
  trafficSplitter: TrafficSplitter;
  dbAdapter: DatabaseAdapter;
  takeoverManager?: TakeoverManager;
}

export async function registerAdminRoutes(fastify: FastifyInstance, deps: AdminRouteDependencies) {
  // Add authentication hook for all admin endpoints
  fastify.addHook("onRequest", authHook);

  // 1. GET /api/v1/admin/metrics
  fastify.get("/api/v1/admin/metrics", async (request, reply) => {
    const query = request.query as any;
    const tenantId = query.tenantId ? String(query.tenantId) : undefined;
    const metrics = await deps.metricAggregator.getDashboardMetrics(tenantId);
    return reply.code(200).send(metrics);
  });

  // 2. GET /api/v1/admin/traces
  fastify.get("/api/v1/admin/traces", async (request, reply) => {
    const query = request.query as any;
    const tenantId = query.tenantId ? String(query.tenantId) : undefined;
    const traces = await deps.metricAggregator.getConversationTraceSummaries(tenantId);
    return reply.code(200).send(traces);
  });

  // 3. POST /api/v1/admin/knowledge/upload
  fastify.post("/api/v1/admin/knowledge/upload", async (request, reply) => {
    const parsed = DocumentIngestionPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Bad Request",
        message: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", "),
      });
    }

    const chunks = await deps.ingestionService.ingestDocument(parsed.data);
    return reply.code(200).send({
      success: true,
      documentId: chunks[0]?.docId || "unknown",
      chunksCount: chunks.length,
    });
  });

  // 4. POST /api/v1/admin/evals/run
  fastify.post("/api/v1/admin/evals/run", async (request, reply) => {
    const body = request.body as any;
    const tenantId = body.tenantId ? String(body.tenantId) : "1";
    const testCasesInput = z.array(EvalTestCaseSchema).safeParse(body.testCases);

    if (!testCasesInput.success) {
      return reply.code(400).send({
        error: "Bad Request",
        message: testCasesInput.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", "),
      });
    }

    const results = await deps.evalTestRunner.runSuite(testCasesInput.data, tenantId);
    const total = results.length;
    const successful = results.filter((r) => r.success).length;
    const avgAccuracy = total > 0 ? results.reduce((acc, r) => acc + r.accuracyScore, 0) / total : 0;

    return reply.code(200).send({
      summary: {
        totalTestCases: total,
        successfulTestCases: successful,
        averageAccuracyScore: parseFloat(avgAccuracy.toFixed(2)),
      },
      results,
    });
  });

  // 5. GET/POST /api/v1/admin/prompts/ab-test
  fastify.get("/api/v1/admin/prompts/ab-test", async (request, reply) => {
    const query = request.query as any;
    const tenantId = query.tenantId ? String(query.tenantId) : "1";
    const promptName = query.promptName ? String(query.promptName) : "support";

    const weights = deps.trafficSplitter.getWeights(tenantId, promptName);
    if (!weights) {
      return reply.code(404).send({
        error: "Not Found",
        message: `No A/B test weights configured for tenant ${tenantId} and prompt ${promptName}.`,
      });
    }
    return reply.code(200).send(weights);
  });

  fastify.post("/api/v1/admin/prompts/ab-test", async (request, reply) => {
    const parsed = AbTestWeightSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Bad Request",
        message: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", "),
      });
    }

    try {
      deps.trafficSplitter.setWeights(parsed.data);
      return reply.code(200).send({ success: true, message: "A/B test weights configured successfully." });
    } catch (err: any) {
      return reply.code(400).send({ error: "Bad Request", message: err.message });
    }
  });

  const humanReplyService = new HumanReplyService(deps.dbAdapter);
  const planeService = new PlaneService(deps.dbAdapter);

  // 6. GET /api/admin/conversations
  fastify.get("/api/admin/conversations", async (request, reply) => {
    const list = await humanReplyService.listConversations();
    return reply.code(200).send(list);
  });

  // 7. GET /api/admin/conversations/:id/messages
  fastify.get("/api/admin/conversations/:id/messages", async (request, reply) => {
    const params = request.params as any;
    const messages = await humanReplyService.getMessages(params.id);
    return reply.code(200).send(messages);
  });

  // 8. POST /api/admin/conversations/:id/takeover
  fastify.post("/api/admin/conversations/:id/takeover", async (request, reply) => {
    const params = request.params as any;
    const result = await humanReplyService.takeover(params.id);
    if (deps.takeoverManager) {
      const leaseDurationMs = (config.HUMAN_SESSION_TIMEOUT_MINUTES || 480) * 60 * 1000;
      deps.takeoverManager.setTakeoverState(params.id, "ACTIVE_HUMAN", "human_agent_admin", leaseDurationMs);
    }
    return reply.code(200).send(result);
  });

  // 9. POST /api/admin/conversations/:id/reply
  fastify.post("/api/admin/conversations/:id/reply", async (request, reply) => {
    const params = request.params as any;
    const body = request.body as any;

    if (!body || typeof body.message !== "string") {
      return reply.code(400).send({
        error: "Bad Request",
        message: "Field 'message' is required and must be a string",
      });
    }

    const result = await humanReplyService.sendReply(params.id, body.message);
    if (deps.takeoverManager) {
      const leaseDurationMs = (config.HUMAN_SESSION_TIMEOUT_MINUTES || 480) * 60 * 1000;
      deps.takeoverManager.setTakeoverState(params.id, "ACTIVE_HUMAN", "human_agent_admin", leaseDurationMs, true);
    }
    return reply.code(200).send(result);
  });

  // 9.5. POST /api/admin/conversations/:id/release
  fastify.post("/api/admin/conversations/:id/release", async (request, reply) => {
    const params = request.params as any;
    try {
      if (deps.takeoverManager) {
        deps.takeoverManager.setTakeoverState(params.id, "ACTIVE_AI");
      }

      const conv = await deps.dbAdapter.getConversation(params.id);
      if (conv && conv.handled_by !== "human") {
        return reply.code(200).send({ success: true, handled_by: conv.handled_by });
      }

      // Generate AI closing summary in the background using existing memory service
      const conversationMemoryService = new ConversationMemoryService();
      deps.dbAdapter.getMessages(params.id).then(async (rawMsgs) => {
        const msgs = rawMsgs.map((m: any, idx: number) => ({
          id: String(m.id || m.Id || idx),
          role: m.role || "customer",
          content: m.content || "",
          timestamp: m.timestamp || m.created_at || new Date().toISOString(),
        }));
        const tickets = await deps.dbAdapter.listAllTickets(params.id);
        conversationMemoryService.generateClosingSummary(params.id, msgs, tickets).catch((err) => {
          console.error("[Release] Summary generation failed:", err.message);
        });
      }).catch((err) => {
        console.error("[Release] Failed to load messages for closing summary:", err.message);
      });

      await deps.dbAdapter.updateHandoffState(params.id, "ai");
      return reply.code(200).send({ success: true, handled_by: "ai" });
    } catch (e: any) {
      return reply.code(500).send({ error: "Failed to release conversation", message: e.message });
    }
  });

  // 9.6. GET /api/admin/conversations/:id/profile
  fastify.get("/api/admin/conversations/:id/profile", async (request, reply) => {
    const params = request.params as any;
    const conversationId = params.id;
    try {
      // 1. Get conversation
      const conv = await deps.dbAdapter.getConversation(conversationId);
      if (!conv) {
        return reply.code(404).send({ error: "Conversation not found" });
      }

      // 2. Get messages
      const messages = await deps.dbAdapter.getMessages(conversationId);

      // 3. Resolve Identity, Profile, Company, Project
      let identity = {
        channel: conv.channel || "line",
        channel_ref: "unknown",
        profile_name: "unknown",
        avatar_url: null as string | null,
        email: "unknown",
        phone: "unknown"
      };

      let company = {
        name: "Orbit Retail",
        industry: "Retail & E-commerce"
      };

      let project = {
        name: "Orbit POS System",
        type: "Support",
        sla: "High (SLA Response: 4 hrs, Resolve: 12 hrs)"
      };

      // If we are using NocoDBAdapter, we can query the database directly for actual profile / company!
      if (typeof (deps.dbAdapter as any).getRows === "function") {
        try {
          const adapter = deps.dbAdapter as any;
          const identityId = adapter.extractId(conv.identity_id);
          if (identityId) {
            const idents = await adapter.getRows(adapter.tableIdentities, { where: `(Id,eq,${identityId})`, limit: 1 });
            if (idents.length > 0) {
              const ident = idents[0];
              identity.channel_ref = ident.channel_ref || "unknown";
              identity.channel = ident.channel || "line";

              const profileId = adapter.extractId(ident.profile_id);
              if (profileId) {
                const profs = await adapter.getRows(adapter.tableProfiles, { where: `(Id,eq,${profileId})`, limit: 1 });
                if (profs.length > 0) {
                  const prof = profs[0];
                  identity.profile_name = prof.display_name || prof.name || "Nattapong";
                  identity.email = prof.email || "nattapong@orbitretail.com";
                  identity.phone = prof.phone || "081-234-5678";
                  identity.avatar_url = prof.avatar_url || null;

                  const compId = adapter.extractId(prof.company_id || prof.company);
                  if (compId) {
                    const comps = await adapter.getRows(adapter.tableCompanies, { where: `(Id,eq,${compId})`, limit: 1 });
                    if (comps.length > 0) {
                      company.name = comps[0].name || "Orbit Retail";
                      company.industry = comps[0].industry || "Retail & E-commerce";
                    }
                  }
                }
              }
            }
          }
        } catch (dbErr: any) {
          console.error("[admin.ts] Failed to query full NocoDB profile path:", dbErr.message);
        }
      } else {
        // Query Postgres
        try {
          const { pool } = require("../../adapters/postgres/PostgresAdapter");
          const res = await pool.query(
            `SELECT 
              i.channel_ref, i.channel, 
              p.name AS profile_name,
              p.id AS profile_id,
              co.name AS company_name
             FROM conversations c
             JOIN identities i ON i.id = c.identity_id
             LEFT JOIN profiles p ON p.id = i.profile_id
             LEFT JOIN companies co ON co.id = p.company_id
             WHERE c.id = $1::integer LIMIT 1`,
            [conversationId]
          );
          if (res.rows.length > 0) {
            const row = res.rows[0];
            identity.channel_ref = row.channel_ref || "unknown";
            identity.channel = row.channel || "line";
            identity.profile_name = row.profile_name || "Nattapong";
            identity.email = "nattapong@orbitretail.com";
            identity.phone = "081-234-5678";
            identity.avatar_url = null;
            company.name = row.company_name || "Orbit Retail";
          }
        } catch (dbErr: any) {
          console.error("[admin.ts] Failed to query full Postgres profile path:", dbErr.message);
        }
      }

      if (identity.channel_ref === "unknown") {
        identity.channel_ref = conv.customer || "U6256f0c1dbb64edacf9cca92904e49b1";
      }
      if (identity.profile_name === "unknown") {
        identity.profile_name = "Nattapong"; // fallback display name
      }

      // 4. Calculate stats
      const totalMessages = messages.length;
      const userMessages = messages.filter((m: any) => m.role === "user" || m.role === "customer" || m.sender === "customer").length;
      const agentMessages = totalMessages - userMessages;
      
      let firstContact = conv.created_at || new Date().toISOString();
      let lastContact = new Date().toISOString();
      if (messages.length > 0) {
        firstContact = messages[0].created_at || messages[0].CreatedAt || firstContact;
        lastContact = messages[messages.length - 1].created_at || messages[messages.length - 1].CreatedAt || lastContact;
      }

      const statistics = {
        total_messages: totalMessages,
        user_messages: userMessages,
        agent_messages: agentMessages,
        first_contact: firstContact,
        last_contact: lastContact,
        handled_by: conv.handled_by || "ai"
      };

      // 5. Generate dynamic AI summary from messages
      let aiSummary = `Customer ${identity.profile_name} from ${company.name} has opened a new conversation room. No messages have been exchanged yet.`;
      if (messages.length > 0) {
        const customerMsgs = messages.filter((m: any) => m.role === "user" || m.role === "customer" || m.sender === "customer");
        const firstQuestion = customerMsgs.length > 0 ? customerMsgs[0].content : messages[0].content;
        const lastMsg = messages[messages.length - 1];

        aiSummary = `${identity.profile_name} from ${company.name} reached out regarding: "${firstQuestion.length > 120 ? firstQuestion.substring(0, 120) + '...' : firstQuestion}".`;
        if (lastMsg) {
          const senderLabel = lastMsg.role === "user" || lastMsg.role === "customer" || lastMsg.sender === "customer" ? "Customer" : "AI/Operator";
          aiSummary += ` The latest update was from the ${senderLabel}: "${lastMsg.content.length > 80 ? lastMsg.content.substring(0, 80) + '...' : lastMsg.content}".`;
        }
      }

      // 6. Customer 360 Evolution (Previous conversations, Ticket history, Customer activity summary)
      let previousConversations: any[] = [];
      let ticketHistory: any[] = [];
      let customerActivitySummary = {
        total_conversations: 1,
        total_tickets: 0,
        resolved_tickets: 0,
        pending_tickets: 0,
        total_messages: totalMessages,
      };

      if (typeof (deps.dbAdapter as any).getRows === "function") {
        try {
          const adapter = deps.dbAdapter as any;
          const identityId = adapter.extractId(conv.identity_id);
          if (identityId) {
            // Find all conversations for this identity
            const allConvs = await adapter.getRows(adapter.tableConversations, {
              where: `(identity_id,eq,${identityId})`,
              limit: 100,
            });

            const otherConvs = allConvs.filter((c: any) => String(c.Id || c.id || c.id1) !== String(conversationId));
            
            // Map previous conversations
            previousConversations = otherConvs.map((c: any) => ({
              id: String(c.Id || c.id || c.id1),
              channel: c.channel || "line",
              status: c.status || "open",
              handled_by: c.handled_by || "ai",
              created_at: c.created_at || c.CreatedAt || new Date().toISOString(),
            }));

            // Get all conversation IDs of this customer
            const convIds = allConvs.map((c: any) => String(adapter.extractId(c.Id || c.id || c.id1)));

            // Fetch tickets
            const allTickets = await adapter.listAllTickets(); // resolves from cache or NocoDB
            ticketHistory = allTickets.filter((t: any) => convIds.includes(String(t.conversationId)));

            // Fetch messages for all convs to sum up messages count
            const allMsgs = await adapter.getRows(adapter.tableMessages, { limit: 1000 });
            const customerMsgs = allMsgs.filter((m: any) => convIds.includes(String(adapter.extractId(m.conversation_id))));

            customerActivitySummary = {
              total_conversations: allConvs.length,
              total_tickets: ticketHistory.length,
              resolved_tickets: ticketHistory.filter((t: any) => t.status === 'Resolved' || t.status === 'Closed' || t.status === 'Done').length,
              pending_tickets: ticketHistory.filter((t: any) => t.status !== 'Resolved' && t.status !== 'Closed' && t.status !== 'Done').length,
              total_messages: customerMsgs.length,
            };
          }
        } catch (err: any) {
          console.error("[admin.ts] Failed to query CRM customer 360 data:", err.message);
        }
      } else {
        // Query Postgres
        try {
          const { pool } = require("../../adapters/postgres/PostgresAdapter");
          // Fetch previous conversations for this identity
          const convRes = await pool.query(
            `SELECT id, channel, status, handled_by, created_at FROM conversations
             WHERE identity_id = (SELECT identity_id FROM conversations WHERE id = $1::integer)
               AND id != $1::integer
             ORDER BY created_at DESC LIMIT 100`,
            [conversationId]
          );
          previousConversations = convRes.rows.map((c: any) => ({
            id: String(c.id),
            channel: c.channel || "line",
            status: c.status || "open",
            handled_by: c.handled_by || "ai",
            created_at: c.created_at instanceof Date ? c.created_at.toISOString() : c.created_at || new Date().toISOString(),
          }));

          // Fetch tickets
          const tixRes = await pool.query(
            `SELECT t.id, t.subject, t.summary, t.status, t.priority
             FROM tickets t
             WHERE t.conversation_id IN (
               SELECT id FROM conversations WHERE identity_id = (SELECT identity_id FROM conversations WHERE id = $1::integer)
             )`,
            [conversationId]
          );
          ticketHistory = tixRes.rows.map((t: any) => {
            const priorityMap: Record<string, string> = { P1: "Critical", P2: "High", P3: "Medium", P4: "Low" };
            const severity = priorityMap[t.priority] || "Low";
            const baseDate = new Date();
            const resolveHoursMap: Record<string, number> = { Critical: 4, High: 12, Medium: 48, Low: 120 };
            const resolveHours = resolveHoursMap[severity] || 120;
            const dueDate = new Date(baseDate.getTime() + resolveHours * 60 * 60 * 1000).toISOString();

            return {
              id: String(t.id),
              id1: String(t.id),
              ticketId: String(t.id),
              conversationId: String(conversationId),
              subject: t.subject,
              summary: t.summary,
              status: t.status,
              priority: t.priority,
              severity,
              dueDate,
              createdAt: baseDate.toISOString(),
            };
          });

          // Fetch messages count
          const msgsCountRes = await pool.query(
            `SELECT COUNT(*)::integer AS count FROM messages
             WHERE conversation_id IN (
               SELECT id FROM conversations WHERE identity_id = (SELECT identity_id FROM conversations WHERE id = $1::integer)
             )`,
            [conversationId]
          );

          customerActivitySummary = {
            total_conversations: previousConversations.length + 1,
            total_tickets: ticketHistory.length,
            resolved_tickets: ticketHistory.filter((t: any) => t.status === 'Resolved' || t.status === 'Closed' || t.status === 'Done').length,
            pending_tickets: ticketHistory.filter((t: any) => t.status !== 'Resolved' && t.status !== 'Closed' && t.status !== 'Done').length,
            total_messages: msgsCountRes.rows[0]?.count || totalMessages,
          };
        } catch (err: any) {
          console.error("[admin.ts] Failed to query CRM customer 360 data:", err.message);
        }
      }

      return reply.code(200).send({
        identity,
        company,
        project,
        statistics,
        ai_summary: aiSummary,
        previous_conversations: previousConversations,
        ticket_history: ticketHistory,
        customer_activity_summary: customerActivitySummary,
      });
    } catch (e: any) {
      return reply.code(500).send({ error: "Failed to load CRM profile", message: e.message });
    }
  });

  // 10. POST /api/admin/tickets/:id/promote
  fastify.post("/api/admin/tickets/:id/promote", async (request, reply) => {
    const params = request.params as any;
    const result = await planeService.promoteTicketToPlane(params.id);
    return reply.code(200).send(result);
  });

  // 11. GET /api/admin/conversations/:id/tickets
  fastify.get("/api/admin/conversations/:id/tickets", async (request, reply) => {
    const params = request.params as any;
    const tickets = await deps.dbAdapter.listAllTickets(params.id);
    return reply.code(200).send(tickets);
  });

  // 12. POST /api/admin/conversations/:id/tickets
  fastify.post("/api/admin/conversations/:id/tickets", async (request, reply) => {
    const params = request.params as any;
    const body = request.body as any;

    if (!body || !body.subject || !body.summary || !body.severity || !body.priority) {
      return reply.code(400).send({
        error: "Bad Request",
        message: "Fields 'subject', 'summary', 'severity', and 'priority' are required",
      });
    }

    const ticketService = new TicketService(deps.dbAdapter);
    const result = await ticketService.createTicket({
      conversationId: params.id,
      subject: body.subject,
      summary: body.summary,
      severity: body.severity,
      priority: body.priority,
      projectId: body.projectId || "1",
    });

    return reply.code(200).send(result);
  });
}
