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
import { pool } from "../../adapters/postgres/PostgresAdapter";

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

  // Validate conversationId and projectId parameters
  fastify.addHook("preHandler", async (request, reply) => {
    const params = request.params as any;
    const routeUrl = (request as any).routeOptions?.url || "";
    if (params && params.id !== undefined && routeUrl) {
      if (routeUrl.includes("/api/admin/conversations/:id")) {
        const id = String(params.id);
        const parsed = parseInt(id, 10);
        if (isNaN(parsed) || parsed <= 0 || id === "null" || id === "undefined") {
          return reply.code(400).send({
            error: "Bad Request",
            message: `Invalid conversationId: ${id}`,
          });
        }
      }
    }

    const query = request.query as any;
    if (query && query.projectId !== undefined) {
      const pId = String(query.projectId);
      const parsed = parseInt(pId, 10);
      if (isNaN(parsed) || parsed <= 0 || pId === "null" || pId === "undefined") {
        return reply.code(400).send({
          error: "Bad Request",
          message: `Invalid projectId: ${pId}`,
        });
      }
    }
  });

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
    const query = request.query as any;
    const projectId = query?.projectId ? String(query.projectId) : undefined;
    const list = await humanReplyService.listConversations(projectId);
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

  // GET /api/admin/conversations/:id/timeline
  fastify.get("/api/admin/conversations/:id/timeline", async (request, reply) => {
    const params = request.params as any;
    const conversationId = params.id;
    try {
      const conv = await deps.dbAdapter.getConversation(conversationId);
      if (!conv) {
        return reply.code(404).send({ error: "Conversation not found" });
      }

      // Query messages
      const { rows: dbMessages } = await pool.query(
        `SELECT id, role, content, created_at FROM messages WHERE conversation_id = $1`,
        [parseInt(conversationId, 10)]
      );

      // Query event logs
      const { rows: dbEvents } = await pool.query(
        `SELECT id, event_type, payload, created_at FROM conversation_events WHERE conversation_id = $1`,
        [parseInt(conversationId, 10)]
      );

      const timelineItems = [
        ...dbMessages.map((m: any) => ({
          id: `msg-${m.id}`,
          type: "message",
          role: m.role,
          content: m.content,
          timestamp: m.created_at,
        })),
        ...dbEvents.map((e: any) => ({
          id: `evt-${e.id}`,
          type: "event",
          eventType: e.event_type,
          payload: JSON.parse(e.payload),
          timestamp: e.created_at,
        })),
      ];

      // Sort chronologically
      timelineItems.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      return reply.code(200).send({ rows: timelineItems });
    } catch (e: any) {
      return reply.code(500).send({ error: "Failed to retrieve timeline", message: e.message });
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
        id: null as number | null,
        name: "",
        company: "",
        environment: "",
        projectType: "",
        defaultPriority: "",
        priorities: [] as any[]
      };

      try {
        const { pool } = require("../../adapters/postgres/PostgresAdapter");
        const projectId = conv.project_id;
        if (projectId) {
          project.id = parseInt(String(projectId), 10);
          
          const projRes = await pool.query(
            `SELECT p.name AS project_name, p.environment, p.project_type, c.name AS company_name 
             FROM projects p 
             LEFT JOIN companies c ON c.id = p.company_id 
             WHERE p.id = $1`,
            [projectId]
          );
          if (projRes.rows.length > 0) {
            project.name = projRes.rows[0].project_name || "";
            project.company = projRes.rows[0].company_name || "";
            project.environment = projRes.rows[0].environment || "";
            project.projectType = projRes.rows[0].project_type || "";
          }

          const slaRes = await pool.query(
            `SELECT priority, priority_name, description, response_hours, resolve_hours, service_window, is_default, display_order 
             FROM project_sla_policies 
             WHERE project_id = $1 
             ORDER BY display_order ASC`,
            [projectId]
          );
          
          if (slaRes.rows.length > 0) {
            project.priorities = slaRes.rows.map((r: any) => ({
              code: r.priority,
              name: r.priority_name || r.priority,
              description: r.description || "",
              responseHours: r.response_hours || r.resolve_hours || 0,
              resolveHours: r.resolve_hours || 0,
              serviceWindow: r.service_window || ""
            }));
            const defRow = slaRes.rows.find((r: any) => r.is_default);
            project.defaultPriority = defRow ? defRow.priority : slaRes.rows[0].priority;
          }
        }
      } catch (err: any) {
        console.error("Failed to dynamically load project details inside profile:", err.message);
      }

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

           const tixRes = await pool.query(
            `SELECT t.id, t.subject, t.summary, t.status, t.priority, t.project_id, t.created_at, p.priority_name, p.resolve_hours
             FROM tickets t
             LEFT JOIN project_sla_policies p ON p.project_id = t.project_id AND p.priority = t.priority
             WHERE t.conversation_id IN (
               SELECT id FROM conversations WHERE identity_id = (SELECT identity_id FROM conversations WHERE id = $1::integer)
             )`,
            [conversationId]
          );
          ticketHistory = tixRes.rows.map((t: any) => {
            const severity = t.priority_name || t.priority || "Low";
            const baseDate = t.created_at ? new Date(t.created_at) : new Date();
            const resolveHours = t.resolve_hours || 120;
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
    const query = request.query as any;
    const projectId = query?.projectId ? String(query.projectId) : undefined;
    const tickets = await deps.dbAdapter.listAllTickets(params.id, projectId);
    return reply.code(200).send(tickets);
  });

  // 11.5. GET /api/admin/tickets
  fastify.get("/api/admin/tickets", async (request, reply) => {
    const query = request.query as any;
    const projectId = query?.projectId ? String(query.projectId) : undefined;
    const tickets = await deps.dbAdapter.listAllTickets(undefined, projectId);
    return reply.code(200).send(tickets);
  });

  // GET /api/admin/tickets/:id
  fastify.get("/api/admin/tickets/:id", async (request, reply) => {
    const params = request.params as any;
    const ticketIdStr = String(params.id);
    const isNumeric = /^\d+$/.test(ticketIdStr);
    const query = isNumeric 
      ? `SELECT * FROM tickets WHERE id = $1` 
      : `SELECT * FROM tickets WHERE ticket_id = $1`;
    const { rows } = await pool.query(query, [isNumeric ? parseInt(ticketIdStr, 10) : ticketIdStr]);
    if (rows.length === 0) {
      return reply.code(404).send({ error: "Ticket not found" });
    }
    const ticket = rows[0];
    return reply.code(200).send({
      id: String(ticket.id),
      ticketId: ticket.ticket_id,
      conversationId: String(ticket.conversation_id),
      projectId: String(ticket.project_id),
      subject: ticket.subject,
      summary: ticket.summary,
      status: ticket.status,
      priority: ticket.priority,
      severity: ticket.severity,
      assignedPm: ticket.assigned_pm,
      createdVia: ticket.created_via,
      planeIssueId: ticket.plane_issue_id,
      dueDate: ticket.due_date ? ticket.due_date.toISOString() : null,
      createdAt: ticket.created_at.toISOString(),
      enrichmentState: ticket.enrichment_state,
      aiTitle: ticket.title,
      runningSummary: ticket.running_summary,
      lastAiSummary: ticket.last_ai_summary,
      duplicateOfTicketId: ticket.duplicate_of_ticket_id ? String(ticket.duplicate_of_ticket_id) : null,
      duplicateScore: ticket.duplicate_score,
      duplicateReason: ticket.duplicate_reason,
      aiConfidenceMetrics: ticket.ai_confidence_metrics,
    });
  });

  // GET /api/admin/traces/raw
  fastify.get("/api/admin/traces/raw", async (request, reply) => {
    const traces = await deps.dbAdapter.listAllTraces();
    return reply.code(200).send(traces);
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

  // ── AX-FE-010: Projects Listing API ─────────────────────────
  fastify.get("/api/v1/admin/projects", async (_request, reply) => {
    try {
      const { pool } = require("../../adapters/postgres/PostgresAdapter");
      const { rows } = await pool.query(
        "SELECT id, name, project_type, created_at FROM projects ORDER BY id ASC"
      );
      const projects = rows.map((r: any) => ({
        id: String(r.id),
        name: r.name,
        projectType: r.project_type,
        createdAt: r.created_at,
      }));
      return reply.code(200).send(projects);
    } catch (err: any) {
      // Fallback for non-postgres environments
      return reply.code(200).send([
        { id: "1", name: "Default Project", projectType: "Support", createdAt: new Date().toISOString() },
      ]);
    }
  });

  // ── AX-BE-060: Admin Settings Controller ────────────────────

  // Helper validation functions
  function validateSla(body: any) {
    const { priority, resolve_hours, response_hours, service_window } = body;
    if (!priority || !/^P[1-5]$/.test(priority)) {
      throw new Error("Invalid priority: must be P1, P2, P3, P4, or P5");
    }
    if (resolve_hours === undefined || isNaN(parseInt(resolve_hours, 10)) || parseInt(resolve_hours, 10) <= 0 || parseInt(resolve_hours, 10) > 720) {
      throw new Error("Invalid resolve_hours: must be an integer between 1 and 720");
    }
    if (response_hours !== undefined && response_hours !== null) {
      const rh = parseInt(response_hours, 10);
      if (isNaN(rh) || rh <= 0 || rh > parseInt(resolve_hours, 10)) {
        throw new Error("Invalid response_hours: must be an integer between 1 and resolve_hours");
      }
    }
    if (service_window && service_window !== "24x7" && service_window !== "Business Hours") {
      throw new Error("Invalid service_window: must be '24x7' or 'Business Hours'");
    }
  }

  function validateBusinessHours(body: any) {
    const { day_of_week, start_time, end_time, timezone } = body;
    const day = parseInt(day_of_week, 10);
    if (day_of_week === undefined || isNaN(day) || day < 0 || day > 6) {
      throw new Error("Invalid day_of_week: must be an integer between 0 and 6");
    }
    const timeRegex = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
    if (!start_time || !timeRegex.test(start_time)) {
      throw new Error("Invalid start_time format (HH:MM or HH:MM:SS required)");
    }
    if (!end_time || !timeRegex.test(end_time)) {
      throw new Error("Invalid end_time format (HH:MM or HH:MM:SS required)");
    }
    // Chronological check
    const startSec = start_time.split(':').reduce((acc: number, val: string) => acc * 60 + parseInt(val, 10), 0);
    const endSec = end_time.split(':').reduce((acc: number, val: string) => acc * 60 + parseInt(val, 10), 0);
    if (startSec >= endSec) {
      throw new Error("start_time must be chronologically before end_time");
    }
    if (timezone) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: timezone });
      } catch (e) {
        throw new Error(`Invalid timezone ID: '${timezone}'`);
      }
    }
  }

  function validateSettings(body: any) {
    const { aiSettings, prompt, featureFlags } = body;
    if (aiSettings) {
      const ct = aiSettings.confidence_threshold !== undefined ? aiSettings.confidence_threshold : aiSettings.confidenceThreshold;
      const mhd = aiSettings.max_handoff_depth !== undefined ? aiSettings.max_handoff_depth : aiSettings.maxHandoffDepth;
      const vmt = aiSettings.vector_match_threshold !== undefined ? aiSettings.vector_match_threshold : aiSettings.vectorMatchThreshold;

      if (ct !== undefined) {
        const val = parseFloat(ct);
        if (isNaN(val) || val < 0.0 || val > 1.0) {
          throw new Error("Invalid confidence_threshold: must be a float between 0.0 and 1.0");
        }
      }
      if (vmt !== undefined) {
        const val = parseFloat(vmt);
        if (isNaN(val) || val < 0.0 || val > 1.0) {
          throw new Error("Invalid vector_match_threshold: must be a float between 0.0 and 1.0");
        }
      }
      if (mhd !== undefined) {
        const val = parseInt(mhd, 10);
        if (isNaN(val) || val < 1 || val > 20) {
          throw new Error("Invalid max_handoff_depth: must be an integer between 1 and 20");
        }
      }
    }
    if (prompt) {
      const si = prompt.system_instruction !== undefined ? prompt.system_instruction : prompt.systemInstruction;
      const temp = prompt.temperature !== undefined ? prompt.temperature : prompt.temperature;
      const mt = prompt.max_tokens !== undefined ? prompt.max_tokens : prompt.maxTokens;

      if (si !== undefined && (typeof si !== "string" || si.trim() === "")) {
        throw new Error("Invalid system_instruction: must be a non-empty string");
      }
      if (temp !== undefined) {
        const val = parseFloat(temp);
        if (isNaN(val) || val < 0.0 || val > 2.0) {
          throw new Error("Invalid temperature: must be a float between 0.0 and 2.0");
        }
      }
      if (mt !== undefined) {
        const val = parseInt(mt, 10);
        if (isNaN(val) || val < 1 || val > 8192) {
          throw new Error("Invalid max_tokens: must be an integer between 1 and 8192");
        }
      }
    }
    if (featureFlags) {
      if (typeof featureFlags !== "object") {
        throw new Error("Invalid featureFlags format: must be an object");
      }
      for (const [key, val] of Object.entries(featureFlags)) {
        if (typeof val !== "boolean") {
          throw new Error(`Invalid feature flag value for flag '${key}': must be boolean`);
        }
      }
    }
  }

  // 1. SLA Policies CRUD
  fastify.get("/api/v1/admin/projects/:id/sla", async (request, reply) => {
    const { id } = request.params as any;
    const { pool } = require("../../adapters/postgres/PostgresAdapter");
    const { rows } = await pool.query(
      "SELECT * FROM project_sla_policies WHERE project_id = $1 ORDER BY display_order ASC, id ASC",
      [parseInt(id, 10)]
    );
    return reply.code(200).send(rows);
  });

  fastify.post("/api/v1/admin/projects/:id/sla", async (request, reply) => {
    const { id } = request.params as any;
    const body = request.body as any;
    const actor = (request.headers["x-actor"] as string) || "admin";
    const { pool } = require("../../adapters/postgres/PostgresAdapter");
    const { ConfigLoaderService } = require("../../services/ConfigLoaderService");

    try {
      validateSla(body);
    } catch (validationErr: any) {
      return reply.code(400).send({ error: "Validation Error", message: validationErr.message });
    }

    const {
      priority,
      resolve_hours,
      priority_name,
      description,
      response_hours,
      service_window,
      display_order,
      is_default,
      is_active
    } = body;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Fetch old value for audit logging
      const oldSla = await client.query(
        "SELECT * FROM project_sla_policies WHERE project_id = $1 AND priority = $2",
        [parseInt(id, 10), priority]
      );
      const oldValue = oldSla.rows[0] || null;

      // Upsert SLA policy
      await client.query(
        `INSERT INTO project_sla_policies (
          project_id, priority, resolve_hours, priority_name, description, 
          response_hours, service_window, display_order, is_default, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (project_id, priority) DO UPDATE SET
          resolve_hours = EXCLUDED.resolve_hours,
          priority_name = COALESCE(EXCLUDED.priority_name, project_sla_policies.priority_name),
          description = COALESCE(EXCLUDED.description, project_sla_policies.description),
          response_hours = COALESCE(EXCLUDED.response_hours, project_sla_policies.response_hours),
          service_window = COALESCE(EXCLUDED.service_window, project_sla_policies.service_window),
          display_order = COALESCE(EXCLUDED.display_order, project_sla_policies.display_order),
          is_default = COALESCE(EXCLUDED.is_default, project_sla_policies.is_default),
          is_active = COALESCE(EXCLUDED.is_active, project_sla_policies.is_active)`,
        [
          parseInt(id, 10),
          priority,
          parseInt(resolve_hours, 10),
          priority_name || null,
          description || null,
          response_hours !== undefined ? parseInt(response_hours, 10) : null,
          service_window || 'Business Hours',
          display_order !== undefined ? parseInt(display_order, 10) : 1,
          is_default === true,
          is_active !== false
        ]
      );

      // Audit Log
      await client.query(
        `INSERT INTO admin_audit_logs (project_id, action, old_value, new_value, actor)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          parseInt(id, 10),
          "UPSERT_SLA_POLICY",
          JSON.stringify(oldValue || {}),
          JSON.stringify(body),
          actor
        ]
      );

      await client.query("COMMIT");
    } catch (err: any) {
      await client.query("ROLLBACK");
      return reply.code(500).send({ error: "Database Error", message: err.message });
    } finally {
      client.release();
    }

    // Evict settings cache
    await ConfigLoaderService.getInstance().invalidateProjectCache(String(id));

    return reply.code(200).send({ success: true });
  });

  fastify.delete("/api/v1/admin/projects/:id/sla/:priority", async (request, reply) => {
    const { id, priority } = request.params as any;
    const actor = (request.headers["x-actor"] as string) || "admin";
    const { pool } = require("../../adapters/postgres/PostgresAdapter");
    const { ConfigLoaderService } = require("../../services/ConfigLoaderService");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Fetch old value for audit logging
      const oldSla = await client.query(
        "SELECT * FROM project_sla_policies WHERE project_id = $1 AND priority = $2",
        [parseInt(id, 10), priority]
      );
      const oldValue = oldSla.rows[0] || null;

      if (!oldValue) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Not Found", message: "SLA Policy not found" });
      }

      await client.query(
        "DELETE FROM project_sla_policies WHERE project_id = $1 AND priority = $2",
        [parseInt(id, 10), priority]
      );

      // Audit Log
      await client.query(
        `INSERT INTO admin_audit_logs (project_id, action, old_value, new_value, actor)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          parseInt(id, 10),
          "DELETE_SLA_POLICY",
          JSON.stringify(oldValue),
          JSON.stringify({}),
          actor
        ]
      );

      await client.query("COMMIT");
    } catch (err: any) {
      await client.query("ROLLBACK");
      return reply.code(500).send({ error: "Database Error", message: err.message });
    } finally {
      client.release();
    }

    await ConfigLoaderService.getInstance().invalidateProjectCache(String(id));

    return reply.code(200).send({ success: true });
  });

  // 2. Business Hours CRUD
  fastify.get("/api/v1/admin/projects/:id/business-hours", async (request, reply) => {
    const { id } = request.params as any;
    const { pool } = require("../../adapters/postgres/PostgresAdapter");
    const { rows } = await pool.query(
      "SELECT * FROM project_business_hours WHERE project_id = $1 ORDER BY day_of_week ASC",
      [parseInt(id, 10)]
    );
    return reply.code(200).send(rows);
  });

  fastify.post("/api/v1/admin/projects/:id/business-hours", async (request, reply) => {
    const { id } = request.params as any;
    const body = request.body as any;
    const actor = (request.headers["x-actor"] as string) || "admin";
    const { pool } = require("../../adapters/postgres/PostgresAdapter");
    const { ConfigLoaderService } = require("../../services/ConfigLoaderService");

    try {
      validateBusinessHours(body);
    } catch (validationErr: any) {
      return reply.code(400).send({ error: "Validation Error", message: validationErr.message });
    }

    const { day_of_week, start_time, end_time, timezone } = body;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Fetch old value for audit logging
      const oldBH = await client.query(
        "SELECT * FROM project_business_hours WHERE project_id = $1 AND day_of_week = $2",
        [parseInt(id, 10), parseInt(day_of_week, 10)]
      );
      const oldValue = oldBH.rows[0] || null;

      // Clean existing business hours for that day
      await client.query(
        "DELETE FROM project_business_hours WHERE project_id = $1 AND day_of_week = $2",
        [parseInt(id, 10), parseInt(day_of_week, 10)]
      );

      // Insert new business hours
      await client.query(
        `INSERT INTO project_business_hours (project_id, day_of_week, start_time, end_time, timezone)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          parseInt(id, 10),
          parseInt(day_of_week, 10),
          start_time,
          end_time,
          timezone || 'UTC'
        ]
      );

      // Audit Log
      await client.query(
        `INSERT INTO admin_audit_logs (project_id, action, old_value, new_value, actor)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          parseInt(id, 10),
          "UPSERT_BUSINESS_HOURS",
          JSON.stringify(oldValue || {}),
          JSON.stringify(body),
          actor
        ]
      );

      await client.query("COMMIT");
    } catch (err: any) {
      await client.query("ROLLBACK");
      return reply.code(500).send({ error: "Database Error", message: err.message });
    } finally {
      client.release();
    }

    await ConfigLoaderService.getInstance().invalidateProjectCache(String(id));

    return reply.code(200).send({ success: true });
  });

  fastify.delete("/api/v1/admin/projects/:id/business-hours/:day", async (request, reply) => {
    const { id, day } = request.params as any;
    const actor = (request.headers["x-actor"] as string) || "admin";
    const { pool } = require("../../adapters/postgres/PostgresAdapter");
    const { ConfigLoaderService } = require("../../services/ConfigLoaderService");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Fetch old value for audit logging
      const oldBH = await client.query(
        "SELECT * FROM project_business_hours WHERE project_id = $1 AND day_of_week = $2",
        [parseInt(id, 10), parseInt(day, 10)]
      );
      const oldValue = oldBH.rows[0] || null;

      if (!oldValue) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Not Found", message: "Business hours not found" });
      }

      await client.query(
        "DELETE FROM project_business_hours WHERE project_id = $1 AND day_of_week = $2",
        [parseInt(id, 10), parseInt(day, 10)]
      );

      // Audit Log
      await client.query(
        `INSERT INTO admin_audit_logs (project_id, action, old_value, new_value, actor)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          parseInt(id, 10),
          "DELETE_BUSINESS_HOURS",
          JSON.stringify(oldValue),
          JSON.stringify({}),
          actor
        ]
      );

      await client.query("COMMIT");
    } catch (err: any) {
      await client.query("ROLLBACK");
      return reply.code(500).send({ error: "Database Error", message: err.message });
    } finally {
      client.release();
    }

    await ConfigLoaderService.getInstance().invalidateProjectCache(String(id));

    return reply.code(200).send({ success: true });
  });

  // 3. Project Settings (Prompt, AI Settings, Feature Flags)
  fastify.get("/api/v1/admin/projects/:id/settings", async (request, reply) => {
    const { id } = request.params as any;
    const { pool } = require("../../adapters/postgres/PostgresAdapter");

    const aiRes = await pool.query(
      "SELECT * FROM project_ai_settings WHERE project_id = $1 LIMIT 1",
      [parseInt(id, 10)]
    );
    const promptRes = await pool.query(
      "SELECT * FROM project_prompts WHERE project_id = $1 ORDER BY id DESC LIMIT 1",
      [parseInt(id, 10)]
    );
    const flagsRes = await pool.query(
      "SELECT * FROM project_feature_flags WHERE project_id = $1",
      [parseInt(id, 10)]
    );

    const featureFlags = flagsRes.rows.reduce((acc: any, curr: any) => {
      acc[curr.flag_name] = curr.is_enabled;
      return acc;
    }, {});

    return reply.code(200).send({
      aiSettings: aiRes.rows[0] || null,
      prompt: promptRes.rows[0] || null,
      featureFlags
    });
  });

  fastify.post("/api/v1/admin/projects/:id/settings", async (request, reply) => {
    const { id } = request.params as any;
    const body = request.body as any;
    const actor = (request.headers["x-actor"] as string) || "admin";
    const { pool } = require("../../adapters/postgres/PostgresAdapter");
    const { ConfigLoaderService } = require("../../services/ConfigLoaderService");

    try {
      validateSettings(body);
    } catch (validationErr: any) {
      return reply.code(400).send({ error: "Validation Error", message: validationErr.message });
    }

    const { aiSettings, prompt, featureFlags } = body;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Fetch old values for audit log
      const oldAi = await client.query("SELECT * FROM project_ai_settings WHERE project_id = $1 LIMIT 1", [parseInt(id, 10)]);
      const oldPrompt = await client.query("SELECT * FROM project_prompts WHERE project_id = $1 ORDER BY id DESC LIMIT 1", [parseInt(id, 10)]);
      const oldFlags = await client.query("SELECT * FROM project_feature_flags WHERE project_id = $1", [parseInt(id, 10)]);
      
      const oldFeatureFlags = oldFlags.rows.reduce((acc: any, curr: any) => {
        acc[curr.flag_name] = curr.is_enabled;
        return acc;
      }, {});

      const oldValue = {
        aiSettings: oldAi.rows[0] || null,
        prompt: oldPrompt.rows[0] || null,
        featureFlags: oldFeatureFlags
      };

      // Save AI Settings
      if (aiSettings) {
        const ct = aiSettings.confidence_threshold !== undefined ? aiSettings.confidence_threshold : aiSettings.confidenceThreshold;
        const mhd = aiSettings.max_handoff_depth !== undefined ? aiSettings.max_handoff_depth : aiSettings.maxHandoffDepth;
        const vmt = aiSettings.vector_match_threshold !== undefined ? aiSettings.vector_match_threshold : aiSettings.vectorMatchThreshold;

        await client.query(
          `INSERT INTO project_ai_settings (project_id, confidence_threshold, max_handoff_depth, vector_match_threshold)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (project_id) DO UPDATE SET
             confidence_threshold = EXCLUDED.confidence_threshold,
             max_handoff_depth = EXCLUDED.max_handoff_depth,
             vector_match_threshold = EXCLUDED.vector_match_threshold`,
          [
            parseInt(id, 10),
            ct !== undefined ? parseFloat(ct) : 0.70,
            mhd !== undefined ? parseInt(mhd, 10) : 5,
            vmt !== undefined ? parseFloat(vmt) : 0.60
          ]
        );
      }

      // Save Prompts
      if (prompt) {
        const si = prompt.system_instruction !== undefined ? prompt.system_instruction : prompt.systemInstruction;
        const mn = prompt.model_name !== undefined ? prompt.model_name : prompt.modelName;
        const temp = prompt.temperature !== undefined ? prompt.temperature : prompt.temperature;
        const mt = prompt.max_tokens !== undefined ? prompt.max_tokens : prompt.maxTokens;

        if (si) {
          await client.query(
            `INSERT INTO project_prompts (project_id, system_instruction, model_name, temperature, max_tokens)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              parseInt(id, 10),
              si,
              mn || 'gemini-1.5-pro',
              temp !== undefined ? parseFloat(temp) : 0.00,
              mt !== undefined ? parseInt(mt, 10) : 2048
            ]
          );
        }
      }

      // Save Feature Flags
      if (featureFlags) {
        for (const [flagName, isEnabled] of Object.entries(featureFlags)) {
          await client.query(
            `INSERT INTO project_feature_flags (project_id, flag_name, is_enabled)
             VALUES ($1, $2, $3)
             ON CONFLICT (project_id, flag_name) DO UPDATE SET
               is_enabled = EXCLUDED.is_enabled`,
            [parseInt(id, 10), flagName, isEnabled === true]
          );
        }
      }

      // Audit Log
      await client.query(
        `INSERT INTO admin_audit_logs (project_id, action, old_value, new_value, actor)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          parseInt(id, 10),
          "UPDATE_PROJECT_SETTINGS",
          JSON.stringify(oldValue),
          JSON.stringify(body),
          actor
        ]
      );

      await client.query("COMMIT");
    } catch (err: any) {
      await client.query("ROLLBACK");
      return reply.code(500).send({ error: "Database Error", message: err.message });
    } finally {
      client.release();
    }

    // Invalidate project settings cache
    await ConfigLoaderService.getInstance().invalidateProjectCache(String(id));

    return reply.code(200).send({ success: true });
  });
}

