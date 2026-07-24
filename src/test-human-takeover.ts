import { TakeoverManager } from "./human-takeover/TakeoverManager";
import { Orchestrator } from "./orchestrator/Orchestrator";
import { LocalDataAdapter } from "./adapters/local-data/LocalDataAdapter";
import { AgentManager } from "./agent/AgentRuntime";
import { McpToolRouter } from "./mcp/McpToolRouter";
import { PolicyEngine } from "./policy/PolicyEngine";
import { ToolRegistry } from "./tools/ToolRegistry";
import { ExecutionTraceService } from "./execution/ExecutionTrace";
import { InboundMessage } from "./schemas/validation";
import * as fs from "fs";
import * as path from "path";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  console.log("=========================================");
  console.log("    AutomationX V2 Human Takeover Tests  ");
  console.log("=========================================");

  const dataDir = path.resolve(__dirname, "../data");
  const takeoverFilePath = path.join(dataDir, "test_takeover_states.json");
  if (fs.existsSync(takeoverFilePath)) {
    try {
      fs.unlinkSync(takeoverFilePath);
    } catch {}
  }

  // Seed mock JSON database files if they are empty
  const seedFile = (name: string, content: any[]) => {
    const files = fs.readdirSync(dataDir);
    const match = files.find(f => f.includes(`(${name})`) && f.endsWith(".json")) ||
                  files.find(f => f.includes(name) && f.endsWith(".json"));
    const filePath = match ? path.join(dataDir, match) : path.join(dataDir, `Ticket V.2 - ${name} (${name}).json`);
    
    let existingContent: any[] = [];
    if (fs.existsSync(filePath)) {
      try {
        existingContent = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch {}
    }
    if (existingContent.length === 0) {
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2), "utf-8");
    }
  };

  seedFile("Companies", [{ id1: "1", name: "Test Company", company: "1", Profiles: "" }]);
  seedFile("Profiles", [{ id1: "1", company_id: "1", name: "Test Profile", company: "1", projects: "", Identities: "", Profile_Projects: "" }]);
  seedFile("Projects", [{ id1: "1", company_id: "1", name: "Test Project", Companies: "", Companies1: "", Profiles: "", Conversations: "", Profile_Projects: "" }]);

  // Setup basic dependencies for Orchestrator
  const dbAdapter = new LocalDataAdapter();
  const toolRegistry = new ToolRegistry();
  const policyEngine = new PolicyEngine(toolRegistry);
  const traceService = new ExecutionTraceService(dbAdapter);
  const mcpToolRouter = new McpToolRouter(policyEngine, traceService, toolRegistry);
  const memoryService = {
    ensureConversation: async (senderId: string, companyId: string, channel: string) => {
      return await dbAdapter.ensureConversation(senderId, companyId, channel);
    },
    loadSessionContext: async (senderId: string, channel: string) => {
      return await dbAdapter.loadSessionContext(senderId, channel);
    },
    appendConversationLog: async (convId: string, role: string, content: string) => {
      await dbAdapter.saveMessage(convId, role, content);
    },
    getConversationHistory: async (convId: string) => {
      return await dbAdapter.getConversationHistory(convId);
    },
    updateHandoffState: async () => {},
  } as any;

  const agentManager = new AgentManager(memoryService, mcpToolRouter, policyEngine, traceService);
  const takeoverManager = new TakeoverManager(takeoverFilePath, 2000); // 2 second default lease
  const orchestrator = new Orchestrator(memoryService, agentManager, takeoverManager);

  const senderId = "takeover_test_user_999";
  const conversationId = await dbAdapter.ensureConversation(senderId, "1", "LINE");

  // 1. Initial State should be ACTIVE_AI
  const initial = await takeoverManager.getTakeoverState(conversationId);
  console.log("Initial state status:", initial.status);
  assert(initial.status === "ACTIVE_AI", "Initial state must be ACTIVE_AI.");

  // 2. Set to ACTIVE_HUMAN with 1.5 second lease
  await takeoverManager.setTakeoverState(conversationId, "ACTIVE_HUMAN", "human_agent_bob", 1500);
  const activeState = await takeoverManager.getTakeoverState(conversationId);
  console.log("Activated human takeover:", activeState.status, "| Assigned agent:", activeState.assignedHumanAgentId);
  assert(activeState.status === "ACTIVE_HUMAN", "Status should be ACTIVE_HUMAN.");
  assert(activeState.assignedHumanAgentId === "human_agent_bob", "Assigned agent should match.");

  // 3. Test Orchestrator bypass
  console.log("Sending customer message during active human takeover...");
  const msg: InboundMessage = {
    senderId,
    channel: "LINE",
    text: "Can someone help me with my billing issue?",
    receivedAt: new Date().toISOString(),
  };

  const reply = await orchestrator.handleIncomingMessage(msg);
  console.log("Orchestrator suppressed reply:", reply.suppressReply);
  assert(reply.suppressReply === true && reply.text === "", "AI must be muted without customer-facing text.");

  // Verify conversation history has the customer message
  const history = await dbAdapter.getConversationHistory(conversationId);
  const lastMsg = history[history.length - 1];
  console.log("Last message in history:", lastMsg.role, "| Content:", lastMsg.content);
  assert(lastMsg.role === "customer" && lastMsg.content === msg.text, "Customer message should be appended to log.");

  // 4. Wait for lease to expire
  console.log("Waiting 2.5 seconds for lease expiration...");
  await delay(2500);

  // Check state again
  const expiredState = await takeoverManager.getTakeoverState(conversationId);
  console.log("State after delay:", expiredState.status);
  assert(expiredState.status === "ACTIVE_AI", "State must revert back to ACTIVE_AI after lease expiration.");

  // Cleanup test file
  if (fs.existsSync(takeoverFilePath)) {
    try {
      fs.unlinkSync(takeoverFilePath);
    } catch {}
  }
  await takeoverManager.disconnect();
  console.log("\n✅ All Human Takeover tests PASSED successfully!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
