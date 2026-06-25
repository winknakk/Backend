import Fastify from "fastify";
import axios from "axios";
import { config } from "../config/env";
import { AdapterFactory } from "../adapters/AdapterFactory";
import { TicketService } from "../tools/TicketService";
import { KnowledgeService } from "../tools/search-project-docs/KnowledgeService";
import { EmbeddingService } from "../rag/EmbeddingService";
import { PgVectorStore } from "../rag/PgVectorStore";
import { VectorStoreRetriever } from "../rag/VectorStoreRetriever";
import { ToolRegistry, CreateTicketTool } from "../tools/ToolRegistry";
import { SearchProjectDocsTool } from "../tools/search-project-docs/SearchProjectDocsTool";
import { PieceAdapter } from "../piece-adapter/PieceAdapter";
import { PieceMcpTool } from "../piece-adapter/PieceMcpTool";
import { DynamicMcpTool } from "../tools/DynamicMcpTool";
import { PromptXMcpClient } from "../mcp/PromptXMcpClient";
import { PolicyEngine } from "../policy/PolicyEngine";
import { ExecutionTraceService } from "../execution/ExecutionTrace";
import { McpToolRouter } from "../mcp/McpToolRouter";
import { MemoryService } from "../memory/MemoryService";
import { AgentManager } from "../agent/AgentRuntime";
import { Orchestrator } from "../orchestrator/Orchestrator";
import { InboundMessageSchema } from "../schemas/validation";
import rootLogger, { createLogger } from "../observability/logger";
import { startTimer } from "../observability/timing";
import { authHook } from "../middleware/auth";
import { webhookSignatureHook } from "../middleware/webhookSignature";
import { rateLimitHook } from "../middleware/rateLimit";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { runMigrations } from "../adapters/postgres/migrations";
import { SyncJobQueue } from "../queue/SyncJobQueue";
import { randomUUID } from "crypto";
import { MetricsService } from "../observability/MetricsService";

const serverLogger = createLogger("server");
const fastify = Fastify({ loggerInstance: rootLogger });

// 1. Initialize Core Services (Adapter & Service Layers)
const dbAdapter = AdapterFactory.getAdapter();
const ticketService = new TicketService(dbAdapter);
const knowledgeRetriever = config.DATABASE_PROVIDER === "postgres"
  ? new VectorStoreRetriever(new EmbeddingService(), new PgVectorStore())
  : undefined;
const knowledgeService = new KnowledgeService(dbAdapter, knowledgeRetriever);

// 2. Initialize Policy, Tool Registry & MCP routing
const toolRegistry = new ToolRegistry();
const policyEngine = new PolicyEngine(toolRegistry);
const traceService = new ExecutionTraceService(dbAdapter);
const mcpRouter = new McpToolRouter(policyEngine, traceService, toolRegistry);

// 3. Setup Memory, Agent Manager, and Orchestrator
const memoryService = new MemoryService(dbAdapter);
const agentManager = new AgentManager(memoryService, mcpRouter, policyEngine);
const orchestrator = new Orchestrator(memoryService, agentManager);
const promptXMcpClient = new PromptXMcpClient();

// 4. Initialize Job Queue
const jobQueue = new SyncJobQueue();

// Register Default Policy Rules
policyEngine.registerRule({
  ruleId: "rule-allow-core",
  name: "Allow Core Tool Commands",
  type: "permission",
  action: "allow",
  mcpToolNames: ["create_ticket", "search_project_docs", "activepieces.nocodb_create_record"]
});

// Register Middleware Hooks
fastify.addHook("onRequest", rateLimitHook);
fastify.addHook("onRequest", authHook);
fastify.addHook("preValidation", webhookSignatureHook);
fastify.addHook("onRequest", async (request) => {
  if (request.url === "/webhook/message" && request.method === "POST") {
    MetricsService.getInstance().recordRequest();
  }
});

async function bootstrap() {
  serverLogger.info("Initializing AutomationX V2 API Server bootstrap...");

  // Run migrations if using Postgres
  if (config.DATABASE_PROVIDER.toLowerCase() === "postgres") {
    try {
      await runMigrations(pool);
    } catch (err: any) {
      serverLogger.error({ error: err.message }, "Database migrations failed on startup. Exiting.");
      process.exit(1);
    }
  }

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
    const nocodbCreateRecordDef = await pieceAdapter.generateMcpDefinition("@activepieces/piece-nocodb", "nocodb-create-record");
    const nocodbPieceTool = new PieceMcpTool(pieceAdapter, "@activepieces/piece-nocodb", "nocodb-create-record", nocodbCreateRecordDef);
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
        mcpToolNames: [remoteName]
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
        message: parsedInput.error.issues.map(e => `${e.path.join(".")}: ${e.message}`).join(", ")
      });
    }

    serverLogger.info({ requestId, component: "server" }, "Enqueuing webhook message job");

    const jobId = await jobQueue.enqueue({
      type: "webhook_message",
      data: parsedInput.data,
      metadata: {
        requestId,
        receivedAt: new Date().toISOString()
      }
    });

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
      message: err.message
    });
  }
});

fastify.get("/health", async (request, reply) => {
  let mcpStatus = "disconnected";
  try {
    const res = await axios.get(config.PROMPTX_MCP_URL, {
      headers: { "Authorization": `Bearer ${config.PROMPTX_MCP_TOKEN}` },
      timeout: 2000
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

  return reply.code(200).send({
    status: "healthy",
    apiStatus: "ok",
    databaseProvider: config.DATABASE_PROVIDER,
    mcpStatus,
    registeredToolsCount: toolRegistry.listTools().length,
    registeredTools: toolRegistry.listTools().map(t => ({
      name: t.definition.name,
      source: t.definition.source || "local",
      version: t.definition.version || "1.0.0",
      description: t.definition.description
    }))
  });
});

fastify.get("/metrics", async (request, reply) => {
  return reply.code(200).send(MetricsService.getInstance().getMetrics());
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
