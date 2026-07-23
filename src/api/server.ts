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
import {
  ToolRegistry,
  CreateTicketTool,
  GetTicketTool,
  GetTicketStatusTool,
  UpdateSummaryTool,
  FindTicketTool,
  MergeTicketTool,
  CloseTicketTool,
  AssignTicketTool,
  EscalateToPmTool,
} from "../tools/ToolRegistry";
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
import { RuntimeContextResolver } from "../services/RuntimeContextResolver";
import { ExecutionTraceService } from "../execution/ExecutionTrace";
import { McpToolRouter } from "../mcp/McpToolRouter";
import { MemoryService } from "../memory/MemoryService";
import { HumanReplyService } from "../services/humanReplyService";
import { PlaneService } from "../services/planeService";
import { PlaneWebhookService, verifyPlaneWebhookSignature } from "../services/planeWebhookService";
import { PlaneReverseSyncPoller } from "../services/PlaneReverseSyncPoller";
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
import { ConfigLoaderService } from "../services/ConfigLoaderService";
import { OutboxProcessor } from "../infrastructure/db/OutboxProcessor";
import { requestContextStorage } from "../shared/context/RequestContextHolder";
import websocketPlugin from "@fastify/websocket";
import WebChatGateway from "../presentation/http/routes/WebChatGateway";
import Redis from "ioredis";

const serverLogger = createLogger("server");
const fastify = Fastify({ loggerInstance: rootLogger as any, bodyLimit: 50 * 1024 * 1024 }); // 50MB body limit for image uploads
fastify.register(websocketPlugin);
const redisPub = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const adminConnections = new Map<any, string>();

// 1. Initialize Core Services (Adapter & Service Layers)
const dbAdapter = AdapterFactory.getAdapter();
const ticketService = new TicketService(dbAdapter);
const runtimeContextResolver = new RuntimeContextResolver(dbAdapter);

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
const planeWebhookService = new PlaneWebhookService(dbAdapter);
const planeReverseSyncPoller = new PlaneReverseSyncPoller(planeWebhookService);
const evalTestRunner = new EvalTestRunner(agentManager, dbAdapter);

async function requestHumanTakeover(input: {
  conversationId: string;
  role?: string;
  content?: string;
  reasonCode?: string;
  reasonDetail?: string;
  source?: string;
}) {
  const { conversationId, role, content, reasonCode, reasonDetail, source } = input;
  await dbAdapter.updateHandoffState(conversationId, "human");
  const pendingDurationMs = config.HUMAN_PENDING_TIMEOUT_MINUTES * 60 * 1000;
  const takeoverState = await takeoverManager.setTakeoverState(
    conversationId,
    "PENDING_HUMAN",
    undefined,
    pendingDurationMs
  );

  if (content) {
    const messages = await dbAdapter.getMessages(conversationId);
    const exists = messages.some((message: any) => message.content === content && message.role === (role || "customer"));
    if (!exists) {
      await dbAdapter.saveMessage(conversationId, role || "customer", content);
    }
  }

  let customerName = `Customer #${conversationId}`;
  let conversationProjectId = "1";
  try {
    const result = await pool.query(
      `SELECT p.name, c.project_id FROM conversations c
       JOIN identities i ON c.identity_id = i.id::varchar
       JOIN profiles p ON i.profile_id = p.id
       WHERE c.id = $1::integer`,
      [conversationId]
    );
    customerName = result.rows[0]?.name || customerName;
    conversationProjectId = String(result.rows[0]?.project_id || conversationProjectId);
  } catch (err: any) {
    serverLogger.error({ error: err.message, conversationId }, "Failed to fetch customer name for takeover notification");
  }

  const notification = JSON.stringify({
    event: "NEW_HUMAN_REQUEST",
    data: {
      conversationId,
      customerName,
      lastMessage: content || "Human assistance required",
      reasonCode: reasonCode || "CUSTOMER_REQUESTED_HUMAN",
      reasonDetail: reasonDetail || null,
      source: source || "workflow",
      expiresAt: takeoverState.leaseExpiresAt,
    },
  });
  for (const [adminSocket, projectId] of adminConnections) {
    if (projectId === conversationProjectId && adminSocket.readyState === 1) adminSocket.send(notification);
  }

  await redisPub.publish(
    "webchat:outbound",
    JSON.stringify({
      conversationId,
      recipientId: "admin",
      channel: "WebChat",
      event: "takeover_change",
      status: "PENDING_HUMAN",
      reasonCode: reasonCode || "CUSTOMER_REQUESTED_HUMAN",
    })
  );

  return takeoverState;
}

const orchestrator = new Orchestrator(memoryService, agentManager, takeoverManager);
const promptXMcpClient = new PromptXMcpClient();

// 4. Initialize Job Queue
const jobQueue = QueueFactory.getQueue();

policyEngine.registerRule({
  ruleId: "rule-allow-core",
  name: "Allow Core Tool Commands",
  type: "permission",
  action: "allow",
  mcpToolNames: [
    "create_ticket",
    "get_ticket",
    "get_ticket_status",
    "update_summary",
    "find_ticket",
    "merge_ticket",
    "close_ticket",
    "assign_ticket",
    "escalate_to_pm",
    "search_project_docs",
    "activepieces.nocodb_create_record"
  ],
});

// Register Middleware Hooks
fastify.addHook("onRequest", (request, reply, done) => {
  const correlationId = (request.headers["x-correlation-id"] as string) || (request.headers["x-request-id"] as string) || randomUUID();
  const requestId = (request.headers["x-request-id"] as string) || randomUUID();
  const projectId = (request.headers["x-project-id"] as string) || (request.query as any)?.projectId || "1";

  const context = {
    correlationId,
    requestId,
    projectId,
    clientChannel: (request.headers["x-client-channel"] as string) || "WebAdmin",
    channelRef: (request.headers["x-channel-ref"] as string) || "admin",
  };

  requestContextStorage.run(context, () => {
    reply.header("x-correlation-id", correlationId);
    done();
  });
});

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
  toolRegistry.registerTool(new GetTicketTool());
  toolRegistry.registerTool(new GetTicketStatusTool());
  toolRegistry.registerTool(new UpdateSummaryTool());
  toolRegistry.registerTool(new FindTicketTool());
  toolRegistry.registerTool(new MergeTicketTool());
  toolRegistry.registerTool(new CloseTicketTool(planeService));
  toolRegistry.registerTool(new AssignTicketTool());
  toolRegistry.registerTool(new EscalateToPmTool());

  // Register the job processor callback
  jobQueue.process(async (job) => {
    if (job.data.channel === "WebChat") {
      try {
        const webhookUrl = `${config.PROMPTX_FLOW_WEBHOOK_URL}/sync`;

        // Ensure local conversation and identity exist first for the stable customer identity
        const localConvId = await memoryService.ensureConversation(job.data.senderId, "1", "WebChat");
        serverLogger.info(`[BullMQ Worker] Ensured local conversation (ID: ${localConvId}) for customer: ${job.data.senderId}`);

        serverLogger.info(`[BullMQ Worker] Forwarding WebChat message to PromptX Flow: ${webhookUrl}`);

        const response = await axios.post(webhookUrl, {
          channel: "WebChat",
          customer_ref: job.data.senderId,
          message: job.data.text
        });

        const replyText = String(response.data.reply_text || "");
        const suppressReply = response.data.suppress_reply === true || replyText.trim().length === 0;
        const convId = response.data.conversation_id;

        serverLogger.info(`[BullMQ Worker] Received sync reply from PromptX Flow: "${replyText}" (convId: ${convId})`);

        if (!suppressReply) {
          const sessionContext = await memoryService.loadSessionContext(job.data.senderId, "WebChat");
          await redisPub.publish(
            "webchat:outbound",
            JSON.stringify({
              conversationId: convId || sessionContext.conversationId,
              recipientId: job.data.senderId,
              channel: "WebChat",
              text: replyText,
              sentAt: new Date().toISOString()
            })
          );
        }

        return { text: replyText, recipientId: job.data.senderId, channel: "WebChat", suppressReply };
      } catch (err: any) {
        const responseData = err.response?.data;
        serverLogger.error({ error: err.message, responseData }, "[BullMQ Worker] Failed calling PromptX Flow webhook");
        throw err;
      }
    } else {
      const result = await orchestrator.handleIncomingMessage(job.data, job.metadata.requestId);
      return result;
    }
  });

  // Boot background Ticket Intelligence workers
  if (typeof (jobQueue as any).startTicketWorkers === "function") {
    serverLogger.info("Starting background Ticket Intelligence Workers...");
    (jobQueue as any).startTicketWorkers();
  }

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

  // 5. Start background outbox polling loop
  const outboxProcessor = new OutboxProcessor();
  outboxProcessor.start(10000);
  planeReverseSyncPoller.start();

  fastify.addHook("onClose", async () => {
    serverLogger.info("Stopping background outbox processor...");
    outboxProcessor.stop();
    planeReverseSyncPoller.stop();
  });
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

fastify.post("/api/v1/internal/debug-log", async (request, reply) => {
  serverLogger.info({ debugData: request.body }, "[Cloud Debug Log]");
  return reply.code(200).send({ success: true });
});

fastify.get("/api/v1/media/file", async (request, reply) => {
  try {
    const query = request.query as any;
    const storageKey = query.key;
    if (!storageKey) {
      return reply.code(400).send({ error: "Missing storage key" });
    }

    const { S3MediaStorageService } = await import("../media/services/S3MediaStorageService");
    const mediaService = new S3MediaStorageService({});
    const { buffer, mimeType } = await mediaService.download(storageKey);

    return reply.type(mimeType).send(buffer);
  } catch (err: any) {
    return reply.code(404).send({ error: "Media file not found", details: err.message });
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
    name: t.name || t.definition.name,
    source: t.definition.source || "local",
    version: t.version || t.definition.version || "1.0.0",
    description: t.description || t.definition.description,
    owner: t.owner || t.definition.owner || "platform-engineering",
    asyncSyncCapability: t.asyncSyncCapability || t.definition.asyncSyncCapability || "sync",
    requiredPermissions: t.requiredPermissions || t.definition.requiredPermissions || [t.name || t.definition.name],
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
  const payload = body.data ? { ...body.data } : body;

  let conversationId = payload.conversationId;
  const parsedConvId = parseInt(String(conversationId), 10);
  if (!conversationId || isNaN(parsedConvId) || parsedConvId <= 0) {
    const convRes = await pool.query(
      `SELECT id FROM conversations WHERE status = 'open' ORDER BY created_at DESC LIMIT 1`
    );
    if (convRes.rows.length > 0) {
      conversationId = convRes.rows[0].id.toString();
    }
  }

  const result = await ticketService.createTicket({
    conversationId,
    subject: payload.subject || "No Subject Provided",
    summary: payload.summary || "No Summary Provided",
    severity: payload.severity || "Medium",
    priority: payload.priority || "P3",
    projectId: payload.projectId || "1",
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
    dueDate,
    data: {
      ticketId,
      status: ticket.status || "Open",
      enrichmentState: ticket.enrichmentState || "PENDING",
      aiConfidenceMetrics: ticket.aiConfidenceMetrics || {
        title: 0.00,
        summary: 0.00,
        duplicate: 0.00
      }
    }
  });
});

fastify.post("/api/v1/tickets", async (request, reply) => {
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
    return reply.code(result.success ? 200 : 500).send(result);
  }
  const ticket = result.data;
  const ticketId = ticket.ticket_id || ticket.ticketId;
  return reply.code(200).send({
    success: true,
    data: {
      ticketId,
      status: ticket.status || "Open",
      enrichmentState: ticket.enrichmentState || "PENDING",
      aiConfidenceMetrics: ticket.aiConfidenceMetrics || {
        title: 0.00,
        summary: 0.00,
        duplicate: 0.00
      }
    }
  });
});

fastify.get("/api/v1/internal/tickets/status", async (request, reply) => {
  const query = request.query as any;
  let projectId = query.projectId;

  if ((!projectId || projectId === "" || projectId === "null" || projectId === "undefined") && query.conversationId) {
    const context = await runtimeContextResolver.resolveRuntimeContext(query.conversationId);
    if (context && context.projectId) {
      projectId = String(context.projectId);
    }
  }

  const tickets = await dbAdapter.listAllTickets(
    query.conversationId,
    projectId,
    query.profileId,
    query.identityId
  );
  return reply.code(200).send(tickets);
});

fastify.post("/api/v1/internal/conversations/takeover", async (request, reply) => {
  const body = request.body as any;
  const payload = body.data ? { ...body.data } : body;
  const conversationId = payload.conversationId;
  const parsed = parseInt(String(conversationId), 10);
  if (isNaN(parsed) || parsed <= 0 || String(conversationId) === "null" || String(conversationId) === "undefined") {
    return reply.code(400).send({ error: "Bad Request", message: "Invalid conversationId" });
  }
  const state = await requestHumanTakeover({
    conversationId: String(conversationId),
    role: payload.role,
    content: payload.content,
    reasonCode: payload.reasonCode || payload.reason_code,
    reasonDetail: payload.reasonDetail || payload.reason_detail,
    source: payload.source || "agentx",
  });
  return reply.code(200).send({
    success: true,
    handled_by: "human",
    status: state.status,
    suppress_reply: true,
    expires_at: state.leaseExpiresAt,
  });
});

fastify.get("/api/admin/socket", { websocket: true }, (connection, req) => {
  const socket = (connection as any).socket;
  const projectId = String((req.query as any)?.projectId || req.headers["x-project-id"] || "1");
  serverLogger.info({ projectId }, "Admin WebSocket connection established");
  adminConnections.set(socket, projectId);

  socket.on("close", () => {
    adminConnections.delete(socket);
    serverLogger.info("Admin WebSocket connection closed");
  });
});

fastify.post("/api/v1/webhooks/human_notify", async (request, reply) => {
  const body = request.body as any;
  const { conversationId, role, content, reasonCode, reasonDetail, source } = body;

  serverLogger.info({ conversationId, role, content }, "Received human_notify takeover webhook");

  if (!conversationId) {
    return reply.code(400).send({ error: "Bad Request", message: "conversationId is required" });
  }

  const state = await requestHumanTakeover({
    conversationId: String(conversationId),
    role,
    content,
    reasonCode,
    reasonDetail,
    source,
  });
  return reply.code(200).send({ success: true, status: state.status, expires_at: state.leaseExpiresAt });
});

fastify.post("/api/v1/internal/conversations/reply", async (request, reply) => {
  const currentTakeover = await takeoverManager.getTakeoverState(body.conversationId);
  if (currentTakeover.status !== "ACTIVE_HUMAN") {
    return reply.code(409).send({
      error: "Takeover required",
      message: "Claim the conversation before sending a human reply.",
      status: currentTakeover.status,
    });
  }
  const rawReplyTo = body.replyToMessageId || body.reply_to_message_id || body.reply_to_id || body.replyToId;
  const replyToId = rawReplyTo ? parseInt(String(rawReplyTo), 10) : undefined;
  const result = await humanReplyService.sendReply(body.conversationId, body.message, replyToId);
  if (takeoverManager) {
    const leaseDurationMs = config.HUMAN_ACTIVE_TIMEOUT_MINUTES * 60 * 1000;
    await takeoverManager.setTakeoverState(body.conversationId, "ACTIVE_HUMAN", "human_agent_admin", leaseDurationMs, true);
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
  await dbAdapter.saveMessage(
    body.conversationId,
    body.role || "human",
    body.content,
    body.externalId || body.external_id,
    body.messageType || body.message_type,
    body.replyToMessageId || body.reply_to_message_id,
    body.quoteToken || body.quote_token
  );
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
  const conversationId = query.conversationId;
  const parsed = parseInt(String(conversationId), 10);
  if (isNaN(parsed) || parsed <= 0 || String(conversationId) === "null" || String(conversationId) === "undefined") {
    return reply.code(400).send({ error: "Bad Request", message: "Invalid conversationId" });
  }
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
  const payload = body.data ? { ...body.data } : body;
  await dbAdapter.updateTicketPlaneIssue(payload.ticketId, payload.planeIssueId);
  return reply.code(200).send({ success: true });
});

fastify.post("/api/v1/webhooks/plane", async (request, reply) => {
  if (!config.PLANE_WEBHOOK_SECRET) {
    return reply.code(503).send({ error: "Plane webhook is not configured" });
  }

  const signature = request.headers["x-plane-signature"] as string | undefined;
  if (!verifyPlaneWebhookSignature(request.body, signature, config.PLANE_WEBHOOK_SECRET)) {
    return reply.code(403).send({ error: "Invalid Plane webhook signature" });
  }

  try {
    const result = await planeWebhookService.sync(request.body as any);
    serverLogger.info(
      {
        deliveryId: request.headers["x-plane-delivery"],
        planeIssueId: result.planeIssueId,
        processed: result.processed,
        matched: result.matched,
        reason: result.reason,
      },
      "Plane webhook handled"
    );
    return reply.code(200).send({ success: true, ...result });
  } catch (error: any) {
    serverLogger.error(
      { deliveryId: request.headers["x-plane-delivery"], error: error.message },
      "Plane webhook failed"
    );
    return reply.code(503).send({ error: "Plane webhook processing failed" });
  }
});

fastify.post("/api/v1/internal/tickets/close", async (request, reply) => {
  const body = request.body as any;
  const payload = body.data ? { ...body.data } : body;
  const tool = toolRegistry.getTool("close_ticket");
  if (!tool) return reply.code(500).send({ error: "Tool close_ticket not found" });
  const context = { correlationId: request.headers["x-correlation-id"], traceId: request.headers["x-trace-id"] };
  try {
    const result = await tool.execute(payload, context);
    return reply.code(200).send(result);
  } catch (err: any) {
    return reply.code(500).send({ error: err.message });
  }
});

fastify.post("/api/v1/internal/tickets/assign", async (request, reply) => {
  const body = request.body as any;
  const payload = body.data ? { ...body.data } : body;
  const tool = toolRegistry.getTool("assign_ticket");
  if (!tool) return reply.code(500).send({ error: "Tool assign_ticket not found" });
  const context = { correlationId: request.headers["x-correlation-id"], traceId: request.headers["x-trace-id"] };
  try {
    const result = await tool.execute(payload, context);
    return reply.code(200).send(result);
  } catch (err: any) {
    return reply.code(500).send({ error: err.message });
  }
});

fastify.post("/api/v1/internal/tickets/merge", async (request, reply) => {
  const body = request.body as any;
  const payload = body.data ? { ...body.data } : body;
  const tool = toolRegistry.getTool("merge_ticket");
  if (!tool) return reply.code(500).send({ error: "Tool merge_ticket not found" });
  const context = { correlationId: request.headers["x-correlation-id"], traceId: request.headers["x-trace-id"] };
  try {
    const result = await tool.execute(payload, context);
    return reply.code(200).send(result);
  } catch (err: any) {
    return reply.code(500).send({ error: err.message });
  }
});

fastify.post("/api/v1/internal/tickets/update-summary", async (request, reply) => {
  const body = request.body as any;
  const payload = body.data ? { ...body.data } : body;
  const tool = toolRegistry.getTool("update_summary");
  if (!tool) return reply.code(500).send({ error: "Tool update_summary not found" });
  const context = { correlationId: request.headers["x-correlation-id"], traceId: request.headers["x-trace-id"] };
  try {
    const result = await tool.execute(payload, context);
    return reply.code(200).send(result);
  } catch (err: any) {
    return reply.code(500).send({ error: err.message });
  }
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

  if (!profileId || profileId === "null" || profileId === "undefined") {
    return reply.code(200).send({
      id: null,
      fields: {
        company_id: { id: null },
        name: null
      }
    });
  }

  const res = await pool.query(
    `SELECT * FROM profiles WHERE id = $1 LIMIT 1`,
    [profileId]
  );

  if (res.rows.length === 0) {
    return reply.code(200).send({
      id: null,
      fields: {
        company_id: { id: null },
        name: null
      }
    });
  }

  const prof = res.rows[0];
  return reply.code(200).send({
    id: prof.id,
    fields: {
      company_id: prof.company_id ? { id: prof.company_id } : { id: null },
      name: prof.name
    }
  });
});

fastify.get("/api/v1/internal/companies/details", async (request, reply) => {
  const query = request.query as any;
  const companyId = query.companyId || query.company_id;

  if (!companyId || companyId === "null" || companyId === "undefined") {
    return reply.code(200).send({
      id: null,
      fields: {
        name: null,
        ai_profile_context: "ผู้ใช้นี้ยังไม่มีข้อมูลบัญชีที่เชื่อมโยงในระบบ กรุณาขอข้อมูลชื่อและชื่อบริษัทของลูกค้าก่อนให้บริการ"
      }
    });
  }

  const res = await pool.query(
    `SELECT * FROM companies WHERE id = $1 LIMIT 1`,
    [companyId]
  );

  if (res.rows.length === 0) {
    return reply.code(200).send({
      id: null,
      fields: {
        name: null,
        ai_profile_context: "ผู้ใช้นี้ยังไม่มีข้อมูลบัญชีที่เชื่อมโยงในระบบ กรุณาขอข้อมูลชื่อและชื่อบริษัทของลูกค้าก่อนให้บริการ"
      }
    });
  }

  const comp = res.rows[0];
  return reply.code(200).send({
    id: comp.id,
    fields: {
      name: comp.name,
      ai_profile_context: comp.ai_profile_context
    }
  });
});

fastify.all("/api/v1/internal/rag", async (request, reply) => {
  const method = request.method;
  let query: string;
  let projectId: string;

  if (method === "GET" || method === "DELETE") {
    const q = request.query as any;
    query = q.query;
    projectId = q.projectId || q.project_id || "1";
  } else {
    const body = (request.body || {}) as any;
    const payload = body.data ? { ...body.data } : body;
    query = payload.query;
    projectId = payload.projectId || payload.project_id || "1";
  }

  const results = await knowledgeService.searchKnowledgeBase(query || "", String(projectId));
  return reply.code(200).send({
    success: true,
    data: { results }
  });
});

fastify.get("/api/v1/internal/config/prompts", async (request, reply) => {
  const query = request.query as any;
  const projectId = query.projectId || request.headers["x-project-id"] || "1";
  const config = await ConfigLoaderService.getInstance().getPromptConfig(String(projectId));
  return reply.code(200).send(config);
});

fastify.get("/api/v1/internal/conversations/search", async (request, reply) => {
  const query = request.query as any;
  const identityId = query.identityId || query.identity_id;
  const status = query.status || "open";
  const projectId = query.projectId || request.headers["x-project-id"];

  let res;
  const isPromptXId = String(identityId).startsWith("convo_") ||
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(identityId));

  if (isPromptXId) {
    res = await pool.query(
      `SELECT * FROM conversations WHERE promptx_conversation_id = $1 LIMIT 1`,
      [identityId]
    );
    if (res.rows.length === 0) {
      const fallbackRes = await pool.query(
        `SELECT * FROM conversations WHERE status = 'open' ORDER BY created_at DESC LIMIT 1`
      );
      if (fallbackRes.rows.length > 0) {
        const convId = fallbackRes.rows[0].id;
        await pool.query(
          `UPDATE conversations SET promptx_conversation_id = $1 WHERE id = $2`,
          [identityId, convId]
        );
        res = fallbackRes;
      }
    }
  } else {
    if (projectId) {
      res = await pool.query(
        `SELECT * FROM conversations WHERE identity_id = $1 AND status = $2 AND project_id = $3 ORDER BY created_at DESC LIMIT 1`,
        [identityId, status, parseInt(String(projectId), 10) || null]
      );
    } else {
      res = await pool.query(
        `SELECT * FROM conversations WHERE identity_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1`,
        [identityId, status]
      );
    }
  }

  if (!res || res.rows.length === 0) {
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
  let projectId = body.projectId || body.project_id || request.headers["x-project-id"];
  let parsedProjectId = projectId ? (parseInt(String(projectId), 10) || null) : null;

  if (!parsedProjectId && body.destination) {
    const channelRes = await pool.query(
      "SELECT project_id FROM project_channels WHERE channel_id = $1 LIMIT 1",
      [body.destination]
    );
    if (channelRes.rows.length > 0) {
      parsedProjectId = channelRes.rows[0].project_id;
    }
  }

  // Get next id
  const nextIdRes = await pool.query("SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM conversations");
  const nextId = nextIdRes.rows[0].next_id;

  const res = await pool.query(
    `INSERT INTO conversations (id, identity_id, channel, status, handled_by, project_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [nextId, identityId, channel, status, handledBy, parsedProjectId]
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
  const conversationId = query.conversationId;
  const parsed = parseInt(String(conversationId), 10);
  if (isNaN(parsed) || parsed <= 0 || String(conversationId) === "null" || String(conversationId) === "undefined") {
    return reply.code(400).send({ error: "Bad Request", message: "Invalid conversationId" });
  }
  const conv = await dbAdapter.getConversation(query.conversationId);
  if (!conv) {
    return reply.code(404).send({ error: "Conversation not found" });
  }
  return reply.code(200).send(conv);
});

fastify.post("/api/v1/internal/sessions/resolve", async (request, reply) => {
  let body = request.body as any;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) {}
  }
  const payload = body.data ? (body.data.data ? body.data.data : body.data) : (body.body ? (body.body.data ? body.body.data : body.body) : body);

  const senderId = payload.senderId || payload.sender_ref || payload.customer_ref;
  const channel = payload.channel || "LINE";
  const messageText = payload.messageText || payload.message || "";
  const isMentioned = payload.isMentioned === true || payload.isMentioned === "true";
  
  // Unify all LINE Gateway / Activepieces / PromptX field aliases (bulletproof deep lookup)
  const imageId = payload.line_image_id 
    || payload.lineImageId 
    || payload.imageId 
    || payload.line_image 
    || payload.message_id 
    || payload.external_id 
    || payload.event?.message?.id 
    || payload.body?.line_image_id
    || payload.body?.message?.id
    || body.line_image_id
    || body.message_id
    || body.external_id
    || body.event?.message?.id
    || null;

  const rawMessageType = payload.messageType || payload.message_type || body.messageType || body.message_type;
  const messageType = rawMessageType || (imageId ? "image" : "text");

  const quoteToken = payload.quoteToken 
    || payload.quote_token 
    || payload.event?.message?.quoteToken 
    || payload.body?.quote_token 
    || body.quote_token 
    || body.event?.message?.quoteToken 
    || null;

  const replyToken = payload.replyToken 
    || payload.reply_token 
    || payload.event?.replyToken 
    || payload.body?.reply_token 
    || body.reply_token 
    || null;

  const externalId = payload.externalId 
    || payload.external_id 
    || imageId 
    || payload.event?.message?.id 
    || body.external_id 
    || body.event?.message?.id 
    || null;

  serverLogger.info({ senderId, messageText, messageType, imageId, quoteToken, replyToken, channel }, "[Webhook] Inbound customer message payload received");

  if (!senderId) {
    return reply.code(400).send({ error: "Bad Request", message: "Missing senderId" });
  }

  try {
    // 1. Ensure conversation and identity exist first for the customer
    await memoryService.ensureConversation(senderId, "1", channel);

    // 2. Load context
    const sessionContext = await memoryService.loadSessionContext(senderId, channel);
    const conversationId = sessionContext.conversationId;

    // Save or update customer message in DB if not created yet by gateway
    let currentMsgRecord: any = null;
    if (conversationId) {
      currentMsgRecord = await dbAdapter.saveMessage(
        conversationId,
        "customer",
        messageText,
        externalId || undefined,
        messageType,
        undefined,
        quoteToken || undefined
      );
    }

    // Auto-ingest LINE image if imageId is provided or messageType is image
    if (imageId || messageType === "image") {
      try {
        const { LINEAdapter } = await import("../presentation/http/adapters/LINEAdapter");
        const { S3MediaStorageService } = await import("../media/services/S3MediaStorageService");
        const mediaStorage = new S3MediaStorageService({});
        const lineToken = (config.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
        const lineAdapter = new LINEAdapter(mediaStorage, lineToken);

        const targetImageId = imageId || (externalId && !externalId.startsWith("msg_") ? externalId : null);
        if (targetImageId) {
          const lineEvent = {
            type: "message",
            message: { type: "image", id: targetImageId, quoteToken },
            source: { userId: senderId },
            timestamp: Date.now()
          };

          const normalized = await lineAdapter.adaptEvent(lineEvent);
          if (normalized && normalized.attachments.length > 0) {
            const att = normalized.attachments[0];

            let messageId = currentMsgRecord?.id ? parseInt(String(currentMsgRecord.id), 10) : null;
            if (!messageId) {
              const existingMsgResult = await pool.query(
                `SELECT m.id FROM messages m
                 LEFT JOIN message_attachments ma ON ma.message_id = m.id
                 WHERE m.conversation_id = $1
                   AND m.message_type = 'image'
                   AND ma.id IS NULL
                 ORDER BY m.id DESC
                 LIMIT 1`,
                [String(conversationId)]
              );
              if (existingMsgResult.rows.length > 0) {
                messageId = existingMsgResult.rows[0].id;
              }
            }

            if (messageId) {
              await pool.query(
                `INSERT INTO message_attachments 
                  (message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata)
                 VALUES 
                  ($1, $2, $3, $4, $5, $6, $7, 'READY', $8)
                 ON CONFLICT DO NOTHING`,
                [
                  messageId,
                  att.fileUrl,
                  att.thumbnailUrl || att.fileUrl,
                  att.fileName,
                  att.fileType,
                  att.fileSize,
                  att.storageKey,
                  JSON.stringify(att.metadata || { sourceChannel: "line", lineImageId: targetImageId })
                ]
              );
              serverLogger.info({ messageId, storageKey: att.storageKey, targetImageId }, "[LINEAdapter] Image attachment saved to DB successfully");
            }
          }
        }
      } catch (mediaErr: any) {
        serverLogger.error({ error: mediaErr.message, senderId, imageId }, "Failed to auto-process incoming LINE image webhook");
      }
    }



    // 3. Find identity & profile details
    const identityResult = await pool.query(
      `SELECT i.id AS identity_id, i.profile_id, p.company_id, p.name AS profile_name
       FROM identities i
       JOIN profiles p ON p.id = i.profile_id
       WHERE LOWER(i.channel) = LOWER($1) AND i.channel_ref = $2
       LIMIT 1`,
      [channel, senderId]
    );

    const identityRow = identityResult.rows[0];
    const profileId = identityRow?.profile_id;
    const profileName = identityRow?.profile_name || "Unknown Customer";
    const companyId = identityRow?.company_id || 1;

    // Get company details
    const companyResult = await pool.query(`SELECT id, name FROM companies WHERE id = $1 LIMIT 1`, [companyId]);
    const companyName = companyResult.rows[0]?.name || "Default Company";

    // 4. Check group policy / shouldProcess
    const policyCheck = await orchestrator.conversationResolver.shouldProcess({
      senderId,
      channel,
      message: messageText,
      isMentioned
    } as any, conversationId);

    // 5. Get active ticket details
    const activeTicket = await dbAdapter.getLatestTicketForConversation(conversationId);

    // 6. Build response components
    const identity = {
      id: identityRow?.identity_id,
      profile_id: profileId,
      channel,
      channel_ref: senderId,
      name: profileName
    };

    const profile = {
      id: profileId,
      company_id: companyId,
      name: profileName
    };

    const company = {
      id: companyId,
      name: companyName
    };

    const takeoverState = await orchestrator.takeoverManager.getTakeoverState(conversationId);
    if (takeoverState.status === "ACTIVE_AI" && sessionContext.handledBy === "human") {
      await dbAdapter.updateHandoffState(conversationId, "ai");
      sessionContext.handledBy = "ai";
    }

    const conversation = {
      id: conversationId,
      identity_id: identityRow?.identity_id,
      status: policyCheck.shouldProcess ? sessionContext.status : "muted",
      handledBy: sessionContext.handledBy,
      channel,
      muteReason: policyCheck.shouldProcess ? null : policyCheck.reason
    };

    const ticket = activeTicket ? {
      id: activeTicket.id,
      ticketCode: activeTicket.ticket_id,
      status: activeTicket.status,
      priority: activeTicket.priority,
      slaBreached: activeTicket.sla_breached || false
    } : null;

    // Check if human takeover is active
    const isHumanTakeover = takeoverState.status === "ACTIVE_HUMAN" || takeoverState.status === "PENDING_HUMAN" || sessionContext.handledBy === "human";

    // Build runtimeFlags
    const runtimeFlags = {
      allowReply: policyCheck.shouldProcess && !isHumanTakeover,
      allowToolExecution: policyCheck.shouldProcess && !isHumanTakeover,
      allowWorkflow: policyCheck.shouldProcess,
      allowMemoryWrite: policyCheck.shouldProcess && !isHumanTakeover
    };

    // Load message history
    const history = await memoryService.getConversationHistory(conversationId, 10);
    const historySummary = history.map(h => `${h.role === 'customer' ? 'Customer' : h.role === 'ai' ? 'Assistant' : 'Support'}: ${h.content}`).join("\n");

    // Notify all connected Admin UI WebSockets that a new message/image has arrived
    const notifyPayload = JSON.stringify({
      event: "NEW_MESSAGE",
      data: {
        conversationId: String(conversationId),
        channel,
        customerName: profileName,
        messageType
      }
    });
    for (const adminSocket of adminConnections.keys()) {
      if (adminSocket.readyState === 1) {
        adminSocket.send(notifyPayload);
      }
    }

    return reply.code(200).send({
      identity,
      profile,
      company,
      conversation,
      ticket,
      runtimeFlags,
      policy: {
        shouldProcess: policyCheck.shouldProcess,
        reason: policyCheck.reason
      },
      sessionMetadata: {
        resolvedAt: new Date().toISOString()
      },
      historySummary
    });
  } catch (err: any) {
    serverLogger.error({ error: err.message, senderId }, "Failed to resolve session context");
    return reply.code(500).send({ error: "Internal Server Error", message: err.message });
  }
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

// Register WebChat Gateway and WebSockets
fastify.register(WebChatGateway);

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
