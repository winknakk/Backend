import Fastify from "fastify";
import axios from "axios";
import { config } from "../config/env";
import { AdapterFactory } from "../adapters/AdapterFactory";
import { TicketService } from "../tools/TicketService";
import { KnowledgeService } from "../tools/search-project-docs/KnowledgeService";
import { EmbeddingService } from "../rag/EmbeddingService";
import { PgVectorStore } from "../rag/PgVectorStore";
import { InMemoryVectorStore } from "../rag/InMemoryVectorStore";
import { VectorStoreRetriever } from "../rag/VectorStoreRetriever";
import { ToolRegistry, CreateTicketTool } from "../tools/ToolRegistry";
import { SearchProjectDocsTool } from "../tools/search-project-docs/SearchProjectDocsTool";
import { PieceAdapter } from "../piece-adapter/PieceAdapter";
import { PieceMcpTool } from "../piece-adapter/PieceMcpTool";
import { DynamicMcpTool } from "../tools/DynamicMcpTool";
import { PromptXMcpClient } from "../mcp/PromptXMcpClient";
import { TakeoverManager } from "../human-takeover/TakeoverManager";
import { TrafficSplitter } from "../aiops/prompt-control/TrafficSplitter";
import { MetricAggregator } from "../aiops/dashboard/MetricAggregator";
import { IngestionService } from "../aiops/ragops/IngestionService";
import { EvalTestRunner } from "../aiops/llmops/EvalTestRunner";
import { registerAdminRoutes } from "./routes/admin";
import { PolicyEngine } from "../policy/PolicyEngine";
import { ExecutionTraceService } from "../execution/ExecutionTrace";
import { McpToolRouter } from "../mcp/McpToolRouter";
import { MemoryService } from "../memory/MemoryService";
import { HumanReplyService } from "../services/humanReplyService";
import { PlaneService } from "../services/planeService";
import { AgentManager } from "../agent/AgentRuntime";
import { Orchestrator } from "../orchestrator/Orchestrator";
import { InboundMessageSchema } from "../schemas/validation";
import rootLogger, { createLogger } from "../observability/logger";
import { startTimer } from "../observability/timing";
import { authHook } from "../middleware/auth";
import { webhookSignatureHook } from "../middleware/webhookSignature";
import { rateLimitHook } from "../middleware/rateLimit";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { QueueFactory } from "../queue/QueueFactory";
import { startConfigWatcher } from "../cache/ConfigWatcher";
import { GracefulShutdownService } from "./GracefulShutdownService";
import { CacheService } from "../cache/CacheService";
import { randomUUID } from "crypto";
import { MetricsService } from "../observability/MetricsService";
import { initOpenTelemetry } from "../observability/openTelemetry";

const serverLogger = createLogger("server");
const fastify = Fastify({ loggerInstance: rootLogger as any });

// 1. Initialize Core Services (Adapter & Service Layers)
const dbAdapter = AdapterFactory.getAdapter();
const ticketService = new TicketService(dbAdapter);

const embeddingService = new EmbeddingService();
const vectorStore =
  config.DATABASE_PROVIDER === "postgres" ? new PgVectorStore() : new InMemoryVectorStore(embeddingService);
const knowledgeRetriever = new VectorStoreRetriever(embeddingService, vectorStore);
const knowledgeService = new KnowledgeService(dbAdapter, knowledgeRetriever);

// 2. Initialize Policy, Tool Registry & MCP routing
const toolRegistry = new ToolRegistry();
const policyEngine = new PolicyEngine(toolRegistry);
const traceService = new ExecutionTraceService(dbAdapter);
const mcpRouter = new McpToolRouter(policyEngine, traceService, toolRegistry);

// 3. Setup Memory, Agent Manager, and Orchestrator
const memoryService = new MemoryService(dbAdapter);
const agentManager = new AgentManager(memoryService, mcpRouter, policyEngine, traceService);

const takeoverManager = new TakeoverManager();
const trafficSplitter = new TrafficSplitter();
const metricAggregator = new MetricAggregator(dbAdapter);
const ingestionService = new IngestionService(vectorStore, embeddingService);
const humanReplyService = new HumanReplyService(dbAdapter);
const planeService = new PlaneService(dbAdapter);
const evalTestRunner = new EvalTestRunner(agentManager, dbAdapter);

const orchestrator = new Orchestrator(memoryService, agentManager, takeoverManager);
const promptXMcpClient = new PromptXMcpClient();

// 4. Initialize Job Queue
const jobQueue = QueueFactory.getQueue();

policyEngine.registerRule({
  ruleId: "rule-allow-core",
  name: "Allow Core Tool Commands",
  type: "permission",
  action: "allow",
  mcpToolNames: ["create_ticket", "search_project_docs", "activepieces.nocodb_create_record"],
});

// Register Middleware Hooks
fastify.addHook("onRequest", async (request, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (request.method === "OPTIONS") {
    return reply.code(200).send();
  }
});

fastify.addHook("onRequest", rateLimitHook);
fastify.addHook("onRequest", authHook);
fastify.addHook("preValidation", webhookSignatureHook);
fastify.addHook("onRequest", async (request) => {
  if (request.url === "/webhook/message" && request.method === "POST") {
    MetricsService.getInstance().recordRequest();
  }
});

async function bootstrap() {
  initOpenTelemetry();
  serverLogger.info("Initializing AutomationX V2 API Server bootstrap...");

  // Register graceful shutdown handlers
  GracefulShutdownService.register(fastify);

  // Start dynamic config watcher for hot reloading
  startConfigWatcher();

  // Register local tools
  const createTicketTool = new CreateTicketTool(ticketService);
  const searchDocsTool = new SearchProjectDocsTool(knowledgeService);
  toolRegistry.registerTool(createTicketTool);
  toolRegistry.registerTool(searchDocsTool);

  // Register the job processor callback
  jobQueue.process(async (job) => {
    return orchestrator.handleIncomingMessage(job.data, job.metadata.requestId);
  });

  // Register Piece Adapter Tool
  try {
    const pieceAdapter = new PieceAdapter();
    const nocodbCreateRecordDef = await pieceAdapter.generateMcpDefinition(
      "@activepieces/piece-nocodb",
      "nocodb-create-record"
    );
    const nocodbPieceTool = new PieceMcpTool(
      pieceAdapter,
      "@activepieces/piece-nocodb",
      "nocodb-create-record",
      nocodbCreateRecordDef
    );
    toolRegistry.registerTool(nocodbPieceTool);
    serverLogger.info("Registered Piece Adapter: activepieces.nocodb_create_record");
  } catch (err: any) {
    serverLogger.error({ error: err.message }, "Failed to register Piece Adapter");
  }

  // Dynamic MCP Tool Discovery
  try {
    serverLogger.info("Querying remote PromptX MCP for tool discovery...");
    const remoteTools = await promptXMcpClient.listTools();
    serverLogger.info(`Found ${remoteTools.length} remote tools on PromptX MCP.`);

    for (const tool of remoteTools) {
      if (tool.name === "chat") {
        continue; // Skip orchestration chat agent tool
      }

      const remoteName = `promptx.${tool.name}`;

      // Ensure policy allows the namespaced tool
      policyEngine.registerRule({
        ruleId: `rule-allow-${remoteName}`,
        name: `Allow dynamic remote tool ${remoteName}`,
        type: "permission",
        action: "allow",
        mcpToolNames: [remoteName],
      });

      const dynamicTool = new DynamicMcpTool(
        remoteName,
        tool.description || "Discovered remote tool",
        tool.inputSchema || { type: "object", properties: {} },
        promptXMcpClient,
        "promptx",
        "1.0.0"
      );

      toolRegistry.registerTool(dynamicTool);
      serverLogger.info(`Dynamically registered and allowed remote tool: '${remoteName}'`);
    }
  } catch (err: any) {
    serverLogger.warn({ error: err.message }, "Dynamic MCP Tool Discovery failed or was skipped");
  }
}

// Routes
fastify.post("/webhook/message", async (request, reply) => {
  const requestId = (request.headers["x-request-id"] as string) || randomUUID();
  const timer = startTimer();

  try {
    const parsedInput = InboundMessageSchema.safeParse(request.body);
    if (!parsedInput.success) {
      serverLogger.warn({ requestId, issues: parsedInput.error.issues }, "Bad request validation failed");
      return reply.code(400).send({
        error: "Bad Request",
        message: parsedInput.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", "),
      });
    }

    serverLogger.info({ requestId, component: "server" }, "Enqueuing webhook message job");

    const jobId = await jobQueue.enqueue({
      type: "webhook_message",
      data: parsedInput.data,
      metadata: {
        requestId,
        receivedAt: new Date().toISOString(),
      },
    });

    if (config.QUEUE_PROVIDER === "redis") {
      const durationMs = timer();
      MetricsService.getInstance().recordLatency(durationMs);
      return reply.code(202).send({
        jobId,
        status: "QUEUED",
      });
    }

    const job = await jobQueue.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found after enqueuing.`);
    }

    if (job.status === "FAILED") {
      throw new Error(job.error || "Job execution failed");
    }

    const durationMs = timer();
    MetricsService.getInstance().recordLatency(durationMs);
    serverLogger.info({ requestId, durationMs, component: "server" }, "Webhook message job completed successfully");
    return reply.code(200).send(job.result);
  } catch (err: any) {
    const durationMs = timer();
    MetricsService.getInstance().recordError();
    MetricsService.getInstance().recordLatency(durationMs);
    serverLogger.error({ requestId, durationMs, error: err.message, component: "server" }, "Webhook handler failed");
    return reply.code(500).send({
      error: "Internal Server Error",
      message: err.message,
    });
  }
});

fastify.get("/health", async (request, reply) => {
  if (GracefulShutdownService.checkShuttingDown()) {
    return reply.code(503).send({
      status: "service_unavailable",
      message: "Server is shutting down",
    });
  }

  let mcpStatus = "disconnected";
  try {
    const res = await axios.get(config.PROMPTX_MCP_URL, {
      headers: { Authorization: `Bearer ${config.PROMPTX_MCP_TOKEN}` },
      timeout: 2000,
    });
    if (res.status >= 200 && res.status < 500) {
      mcpStatus = "connected";
    }
  } catch (err: any) {
    if (err.response && err.response.status >= 200 && err.response.status < 500) {
      mcpStatus = "connected";
    } else {
      mcpStatus = "disconnected";
    }
  }

  const queueDepth =
    typeof (jobQueue as any).getQueueDepth === "function" ? await (jobQueue as any).getQueueDepth() : 0;

  return reply.code(200).send({
    status: "healthy",
    apiStatus: "ok",
    databaseProvider: config.DATABASE_PROVIDER,
    mcpStatus,
    redisCacheActive: CacheService.getInstance().isRedisActive(),
    queueDepth,
    breakerState: PromptXMcpClient.circuitBreaker.getState(),
    registeredToolsCount: toolRegistry.listTools().length,
    registeredTools: toolRegistry.listTools().map((t) => ({
      name: t.definition.name,
      source: t.definition.source || "local",
      version: t.definition.version || "1.0.0",
      description: t.definition.description,
    })),
  });
});

fastify.get("/metrics", async (request, reply) => {
  const mainMetrics = MetricsService.getInstance().getMetrics();
  const cacheMetrics = CacheService.getInstance().getMetrics();
  return reply.code(200).send({
    ...mainMetrics,
    cache: cacheMetrics,
  });
});

fastify.get("/metrics/prometheus", async (request, reply) => {
  const mainMetrics = MetricsService.getInstance().getMetrics();
  const cacheMetrics = CacheService.getInstance().getMetrics();
  
  let qDepth = 0;
  try {
    qDepth = typeof (jobQueue as any).getQueueDepth === "function" ? await (jobQueue as any).getQueueDepth() : 0;
  } catch (err: any) {
    serverLogger.warn({ error: err.message }, "Failed to get queue depth for Prometheus metrics");
  }

  let prometheusText = "";

  // 1. Requests Total
  prometheusText += `# HELP automationx_requests_total Total number of inbound webhook requests.\n`;
  prometheusText += `# TYPE automationx_requests_total counter\n`;
  prometheusText += `automationx_requests_total ${mainMetrics.requestCount}\n\n`;

  // 2. Errors Total
  prometheusText += `# HELP automationx_errors_total Total number of failed requests.\n`;
  prometheusText += `# TYPE automationx_errors_total counter\n`;
  prometheusText += `automationx_errors_total ${mainMetrics.errors}\n\n`;

  // 3. Latency Summary
  prometheusText += `# HELP automationx_request_latency_seconds_sum Total request duration in seconds.\n`;
  prometheusText += `# TYPE automationx_request_latency_seconds_sum counter\n`;
  prometheusText += `automationx_request_latency_seconds_sum ${mainMetrics.latency.sum / 1000}\n\n`;

  prometheusText += `# HELP automationx_request_latency_seconds_count Total number of measured requests.\n`;
  prometheusText += `# TYPE automationx_request_latency_seconds_count counter\n`;
  prometheusText += `automationx_request_latency_seconds_count ${mainMetrics.latency.count}\n\n`;

  // 4. Agent Calls
  prometheusText += `# HELP automationx_agent_calls_total Number of calls to different agents.\n`;
  prometheusText += `# TYPE automationx_agent_calls_total counter\n`;
  for (const [agent, count] of Object.entries(mainMetrics.agentCalls)) {
    prometheusText += `automationx_agent_calls_total{agent="${agent}"} ${count}\n`;
  }
  prometheusText += `\n`;

  // 5. Tool Calls
  prometheusText += `# HELP automationx_tool_calls_total Number of executions of MCP tools.\n`;
  prometheusText += `# TYPE automationx_tool_calls_total counter\n`;
  for (const [tool, count] of Object.entries(mainMetrics.toolCalls)) {
    prometheusText += `automationx_tool_calls_total{tool="${tool}"} ${count}\n`;
  }
  prometheusText += `\n`;

  // 6. Routing Decisions
  prometheusText += `# HELP automationx_routing_decisions_total Number of routing decisions made.\n`;
  prometheusText += `# TYPE automationx_routing_decisions_total counter\n`;
  for (const [decision, count] of Object.entries(mainMetrics.routingDecisions)) {
    prometheusText += `automationx_routing_decisions_total{decision="${decision}"} ${count}\n`;
  }
  prometheusText += `\n`;

  // 7. Cache Metrics
  prometheusText += `# HELP automationx_cache_hits_total Number of cache hits.\n`;
  prometheusText += `# TYPE automationx_cache_hits_total counter\n`;
  prometheusText += `# HELP automationx_cache_misses_total Number of cache misses.\n`;
  prometheusText += `# TYPE automationx_cache_misses_total counter\n`;
  prometheusText += `# HELP automationx_cache_hit_ratio Cache hit ratio percentage.\n`;
  prometheusText += `# TYPE automationx_cache_hit_ratio gauge\n`;

  for (const [tenant, data] of Object.entries(cacheMetrics)) {
    const cacheData = data as { hits: number; misses: number; ratio: number };
    prometheusText += `automationx_cache_hits_total{tenant="${tenant}"} ${cacheData.hits}\n`;
    prometheusText += `automationx_cache_misses_total{tenant="${tenant}"} ${cacheData.misses}\n`;
    prometheusText += `automationx_cache_hit_ratio{tenant="${tenant}"} ${cacheData.ratio}\n`;
  }
  prometheusText += `\n`;

  // 8. Queue depth
  prometheusText += `# HELP automationx_queue_depth Current depth of message queues.\n`;
  prometheusText += `# TYPE automationx_queue_depth gauge\n`;
  prometheusText += `automationx_queue_depth ${qDepth}\n`;

  return reply.type("text/plain; version=0.0.4").send(prometheusText);
});

fastify.get("/traces", async (request, reply) => {
  const traces = await traceService.listTraces();
  return reply.code(200).send(traces);
});

fastify.get("/tools", async (request, reply) => {
  const tools = toolRegistry.listTools().map((t) => ({
    name: t.definition.name,
    source: t.definition.source || "local",
    version: t.definition.version || "1.0.0",
    description: t.definition.description,
    inputSchema: t.definition.inputSchema,
  }));
  return reply.code(200).send(tools);
});

fastify.get("/agents", async (request, reply) => {
  const agents = orchestrator.agentManager.agentRouter.listAgents().map((a) => ({
    id: a.id,
    name: a.name,
  }));
  return reply.code(200).send(agents);
});

fastify.post("/api/v1/internal/tickets", async (request, reply) => {
  const body = request.body as any;
  const result = await ticketService.createTicket({
    conversationId: body.conversationId,
    subject: body.subject,
    summary: body.summary,
    severity: body.severity,
    priority: body.priority,
    projectId: body.projectId || "1",
  });
  if (!result.success || !result.data) {
    return reply.code(200).send(result);
  }
  const ticket = result.data;
  const ticketId = ticket.ticket_id || ticket.ticketId;
  const dueDate = ticket.due_date || ticket.dueDate;
  return reply.code(200).send({
    success: true,
    ticketId,
    dueDate
  });
});

fastify.get("/api/v1/internal/tickets/status", async (request, reply) => {
  const query = request.query as any;
  const tickets = await dbAdapter.listAllTickets(query.conversationId);
  return reply.code(200).send(tickets);
});

fastify.post("/api/v1/internal/conversations/takeover", async (request, reply) => {
  const body = request.body as any;
  await dbAdapter.updateHandoffState(body.conversationId, "human");
  if (takeoverManager) {
    const leaseDurationMs = (config.HUMAN_SESSION_TIMEOUT_MINUTES || 480) * 60 * 1000;
    takeoverManager.setTakeoverState(body.conversationId, "ACTIVE_HUMAN", "human_agent_admin", leaseDurationMs);
  }
  return reply.code(200).send({ success: true, handled_by: "human" });
});

fastify.post("/api/v1/internal/conversations/reply", async (request, reply) => {
  const body = request.body as any;
  const result = await humanReplyService.sendReply(body.conversationId, body.message);
  if (takeoverManager) {
    const leaseDurationMs = (config.HUMAN_SESSION_TIMEOUT_MINUTES || 480) * 60 * 1000;
    takeoverManager.setTakeoverState(body.conversationId, "ACTIVE_HUMAN", "human_agent_admin", leaseDurationMs, true);
  }
  return reply.code(200).send(result);
});

fastify.post("/api/v1/internal/tickets/promote", async (request, reply) => {
  const body = request.body as any;
  const result = await planeService.promoteTicketToPlane(body.ticketId);
  return reply.code(200).send(result);
});

fastify.post("/api/v1/internal/messages", async (request, reply) => {
  const body = request.body as any;
  await dbAdapter.saveMessage(body.conversationId, body.role || "human", body.content);
  return reply.code(200).send({ success: true });
});

fastify.get("/api/v1/internal/messages", async (request, reply) => {
  const query = request.query as any;
  const messages = await dbAdapter.getMessages(query.conversationId);
  const list = messages.map((m: any) => ({
    id: m.id,
    fields: {
      id: m.id,
      role: m.role,
      content: m.content,
      conversation_id: m.conversation_id
    }
  }));
  return reply.code(200).send(list);
});

fastify.get("/api/v1/internal/conversations/identity", async (request, reply) => {
  const query = request.query as any;
  const ident = await dbAdapter.getConversationIdent(query.conversationId);
  return reply.code(200).send(ident);
});

fastify.get("/api/v1/internal/tickets/details", async (request, reply) => {
  const query = request.query as any;
  const result = await dbAdapter.getTicketCompanyContext(query.ticketId);
  return reply.code(200).send(result);
});

fastify.post("/api/v1/internal/tickets/update-plane", async (request, reply) => {
  const body = request.body as any;
  await dbAdapter.updateTicketPlaneIssue(body.ticketId, body.planeIssueId);
  return reply.code(200).send({ success: true });
});

fastify.get("/api/v1/internal/identities/search", async (request, reply) => {
  const query = request.query as any;
  const channel = query.channel;
  const channelRef = query.channelRef || query.channel_ref;
  
  const res = await pool.query(
    `SELECT * FROM identities WHERE channel = $1 AND channel_ref = $2 LIMIT 1`,
    [channel, channelRef]
  );
  
  if (res.rows.length === 0) {
    return reply.code(200).send([]);
  }
  
  const ident = res.rows[0];
  return reply.code(200).send([
    {
      id: ident.id,
      fields: {
        profile_id: ident.profile_id ? { id: ident.profile_id } : null
      }
    }
  ]);
});

fastify.get("/api/v1/internal/identities/details", async (request, reply) => {
  const query = request.query as any;
  const identityId = query.identityId || query.identity_id;
  const res = await pool.query(
    `SELECT * FROM identities WHERE id = $1 LIMIT 1`,
    [identityId]
  );
  if (res.rows.length === 0) {
    return reply.code(404).send({ error: "Identity not found" });
  }
  const ident = res.rows[0];
  return reply.code(200).send({
    id: ident.id,
    fields: {
      id: ident.id,
      profile_id: ident.profile_id ? { id: ident.profile_id } : null,
      channel: ident.channel,
      channel_ref: ident.channel_ref
    }
  });
});

fastify.get("/api/v1/internal/profiles/details", async (request, reply) => {
  const query = request.query as any;
  const profileId = query.profileId || query.profile_id;
  
  const res = await pool.query(
    `SELECT * FROM profiles WHERE id = $1 LIMIT 1`,
    [profileId]
  );
  
  if (res.rows.length === 0) {
    return reply.code(404).send({ error: "Profile not found" });
  }
  
  const prof = res.rows[0];
  return reply.code(200).send({
    id: prof.id,
    fields: {
      company_id: prof.company_id ? { id: prof.company_id } : null,
      name: prof.name
    }
  });
});

fastify.get("/api/v1/internal/companies/details", async (request, reply) => {
  const query = request.query as any;
  const companyId = query.companyId || query.company_id;
  
  const res = await pool.query(
    `SELECT * FROM companies WHERE id = $1 LIMIT 1`,
    [companyId]
  );
  
  if (res.rows.length === 0) {
    return reply.code(404).send({ error: "Company not found" });
  }
  
  const comp = res.rows[0];
  return reply.code(200).send({
    id: comp.id,
    fields: {
      name: comp.name
    }
  });
});

fastify.get("/api/v1/internal/conversations/search", async (request, reply) => {
  const query = request.query as any;
  const identityId = query.identityId || query.identity_id;
  const status = query.status || "open";
  
  const res = await pool.query(
    `SELECT * FROM conversations WHERE identity_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1`,
    [identityId, status]
  );
  
  if (res.rows.length === 0) {
    return reply.code(200).send([]);
  }
  
  const conv = res.rows[0];
  return reply.code(200).send([
    {
      id: conv.id,
      fields: {
        id: conv.id,
        identity_id: conv.identity_id,
        project_id: conv.project_id,
        channel: conv.channel,
        status: conv.status,
        handled_by: conv.handled_by,
        assigned_pm: conv.assigned_pm
      }
    }
  ]);
});

fastify.post("/api/v1/internal/conversations", async (request, reply) => {
  const body = request.body as any;
  const identityId = body.identityId || body.identity_id;
  const channel = body.channel;
  const status = body.status || "open";
  const handledBy = body.handledBy || body.handled_by || "ai";
  
  const res = await pool.query(
    `INSERT INTO conversations (identity_id, channel, status, handled_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [identityId, channel, status, handledBy]
  );
  
  const conv = res.rows[0];
  return reply.code(200).send({
    id: conv.id,
    fields: {
      id: conv.id,
      identity_id: conv.identity_id,
      project_id: conv.project_id,
      channel: conv.channel,
      status: conv.status,
      handled_by: conv.handled_by,
      assigned_pm: conv.assigned_pm
    }
  });
});

fastify.get("/api/v1/internal/conversations/details", async (request, reply) => {
  const query = request.query as any;
  const conv = await dbAdapter.getConversation(query.conversationId);
  if (!conv) {
    return reply.code(404).send({ error: "Conversation not found" });
  }
  return reply.code(200).send(conv);
});

// Register Phase 9 Admin Routes
registerAdminRoutes(fastify, {
  metricAggregator,
  ingestionService,
  evalTestRunner,
  trafficSplitter,
  dbAdapter,
  takeoverManager,
});

const start = async () => {
  try {
    await bootstrap();
    const port = config.PORT || 3000;
    await fastify.listen({ port, host: "0.0.0.0" });
    serverLogger.info(`[Server] AutomationX V2 Server running at http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

export { fastify, bootstrap, toolRegistry, orchestrator, dbAdapter, traceService };
