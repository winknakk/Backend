import * as fs from "fs";
import * as path from "path";
import { config } from "./config/env";
import { Orchestrator } from "./orchestrator/Orchestrator";
import { ToolRegistry, CreateTicketTool } from "./tools/ToolRegistry";
import { SearchProjectDocsTool } from "./tools/search-project-docs/SearchProjectDocsTool";
import { TicketService } from "./tools/TicketService";
import { KnowledgeService } from "./tools/search-project-docs/KnowledgeService";
import { PolicyEngine } from "./policy/PolicyEngine";
import { ExecutionTraceService } from "./execution/ExecutionTrace";
import { McpToolRouter } from "./mcp/McpToolRouter";
import { AgentManager } from "./agent/AgentRuntime";
import { MemoryService } from "./memory/MemoryService";
import { AdapterFactory } from "./adapters/AdapterFactory";
import { InboundMessage } from "./schemas/validation";

async function runIntegrationTest() {
  console.log("=========================================");
  console.log("  AutomationX V2 Phase 3: Knowledge Test ");
  console.log("=========================================\n");

  process.env.NODE_ENV = "development";
  delete process.env.NOCODB_API_TOKEN; // Ensure local mock fallback for NocoDB adapter

  // Clean up persistent state for test sender to avoid test pollution
  const dataDir = path.resolve(__dirname, "../data");
  const cleanTestState = () => {
    const files = fs.readdirSync(dataDir);

    // Clean Conversations
    const convFile = files.find((f) => f.includes("Conversations") && f.endsWith(".json"));
    if (convFile) {
      const filePath = path.join(dataDir, convFile);
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const filtered = data.filter((item: any) => item.id1 !== "67");
      fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2), "utf-8");
    }

    // Clean Messages
    const msgFile = files.find((f) => f.includes("Messages") && f.endsWith(".json"));
    if (msgFile) {
      const filePath = path.join(dataDir, msgFile);
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const filtered = data.filter((item: any) => item.conversation_id !== "67" && item.conversation !== "67");
      fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2), "utf-8");
    }

    // Clean Tickets
    const tktFile = files.find((f) => f.includes("Tickets") && f.endsWith(".json"));
    if (tktFile) {
      const filePath = path.join(dataDir, tktFile);
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const filtered = data.filter((item: any) => item.conversation_id !== "67" && item.conversation !== "67");
      fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2), "utf-8");
    }

    // Clean Traces
    const traceFile = files.find((f) => f.includes("Traces") && f.endsWith(".json"));
    if (traceFile) {
      const filePath = path.join(dataDir, traceFile);
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const filtered = data.filter((item: any) => item.sessionId !== "sess_67");
      fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2), "utf-8");
    }
  };
  cleanTestState();

  // 1. Instantiate Core services (Adapter & Service Layers)
  const dbAdapter = AdapterFactory.getAdapter();
  const ticketService = new TicketService(dbAdapter);
  const knowledgeService = new KnowledgeService(dbAdapter);

  // 2. Instantiate Policy, Tool Registry & MCP routing
  const toolRegistry = new ToolRegistry();
  const policyEngine = new PolicyEngine(toolRegistry);
  const traceService = new ExecutionTraceService(dbAdapter);
  const mcpRouter = new McpToolRouter(policyEngine, traceService, toolRegistry);

  // 3. Register tools
  const createTicketTool = new CreateTicketTool(ticketService);
  const searchDocsTool = new SearchProjectDocsTool(knowledgeService);
  toolRegistry.registerTool(createTicketTool);
  toolRegistry.registerTool(searchDocsTool);

  // 4. Instantiate Tenant and Memory Layers
  const memoryService = new MemoryService(dbAdapter);

  // 5. Setup Agent Manager and Orchestrator
  const agentManager = new AgentManager(memoryService, mcpRouter, policyEngine);
  const orchestrator = new Orchestrator(memoryService, agentManager);

  // --- Register Security Rules (Policy Check) ---
  policyEngine.registerRule({
    ruleId: "rule-1",
    name: "Allow Tool Commands",
    type: "permission",
    action: "allow",
    mcpToolNames: ["create_ticket", "search_project_docs"],
  });

  // Keep track of ticket count before scenarios
  const files = fs.readdirSync(dataDir);
  let ticketFile = files.find((f) => f.includes("Tickets") && f.endsWith(".json"));
  if (!ticketFile) {
    ticketFile = "Ticket V.2 - Tickets (Tickets).json";
    fs.writeFileSync(path.join(dataDir, ticketFile), "[]", "utf-8");
  }
  const currentTicketFile = ticketFile;
  const getTicketCount = () => {
    const raw = fs.readFileSync(path.join(dataDir, currentTicketFile), "utf-8");
    return JSON.parse(raw).filter((t: any) => t.id1 !== null).length;
  };

  const initialTicketCount = getTicketCount();
  console.log(`[Test Setup] Initial ticket count in JSON: ${initialTicketCount}`);

  // =========================================================================
  // --- Case 1: Known resolved issue ("Orbit App session expired") ---
  // =========================================================================
  console.log("\n=========================================");
  console.log("  CASE 1: Known Resolved Issue Test      ");
  console.log("=========================================");

  const msg1: InboundMessage = {
    senderId: "U6256f0c4dbb64edacf9eea92904e49b1",
    channel: "LINE",
    text: "Cannot login Orbit App session expired",
    receivedAt: new Date().toISOString(),
  };

  const reply1 = await orchestrator.handleIncomingMessage(msg1);

  // Check if ticket was created
  const postCase1TicketCount = getTicketCount();
  console.log(`[Case 1 Result] Ticket count after Case 1: ${postCase1TicketCount}`);

  if (postCase1TicketCount === initialTicketCount) {
    console.log("✅ Case 1 Success: Agent answered directly using knowledge. NO ticket was created.");
  } else {
    console.error("❌ Case 1 Failed: A ticket was unexpectedly created!");
  }

  // =========================================================================
  // --- Case 2: Unknown issue ("เข้าใช้งานระบบ SSO ไม่ได้ Error 500") ---
  // =========================================================================
  console.log("\n=========================================");
  console.log("  CASE 2: Unknown Issue Test             ");
  console.log("=========================================");

  const msg2: InboundMessage = {
    senderId: "U6256f0c4dbb64edacf9eea92904e49b1",
    channel: "LINE",
    text: "เข้าใช้งานระบบ SSO ไม่ได้ Error 500",
    receivedAt: new Date().toISOString(),
  };

  const reply2 = await orchestrator.handleIncomingMessage(msg2);

  // Check if ticket was created
  const postCase2TicketCount = getTicketCount();
  console.log(`[Case 2 Result] Ticket count after Case 2: ${postCase2TicketCount}`);

  if (postCase2TicketCount > postCase1TicketCount) {
    console.log("✅ Case 2 Success: No matching solution was found. Ticket was created in database.");
  } else {
    console.error("❌ Case 2 Failed: Agent failed to create a ticket!");
  }

  // =========================================================================
  // --- Audit Traces Verification ---
  // =========================================================================
  console.log("\n=========================================");
  console.log("  Verifying Audit Execution Traces       ");
  console.log("=========================================");

  const sessionContext = await memoryService.loadSessionContext(msg2.senderId, msg2.channel);
  const traces = await traceService.listTracesForSession(sessionContext.sessionId);

  console.log(`Found ${traces.length} tool calls logged in trace service:`);
  traces.forEach((t, i) => {
    console.log(`\nTrace #${i + 1} details:`);
    console.log(`- Trace ID: ${t.traceId}`);
    console.log(`- Tool Name: ${t.toolName}`);
    console.log(`- Arguments: ${JSON.stringify(t.arguments)}`);
    console.log(`- Status: ${t.status}`);
    console.log(`- Result: ${JSON.stringify(t.result).slice(0, 150)}...`);
  });

  if (traces.some((t) => t.toolName === "search_project_docs") && traces.some((t) => t.toolName === "create_ticket")) {
    console.log("\n✅ Test Passed: All execution traces logged correctly!");
  } else {
    console.error("❌ Test Failed: Missing search_project_docs or create_ticket in trace log!");
  }
  console.log("=========================================\n");
}

runIntegrationTest().catch(console.error);
