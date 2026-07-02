import { Orchestrator } from "../src/orchestrator/Orchestrator";
import { MemoryService } from "../src/memory/MemoryService";
import { AgentManager } from "../src/agent/AgentRuntime";
import { TakeoverManager } from "../src/human-takeover/TakeoverManager";
import { AdapterFactory } from "../src/adapters/AdapterFactory";
import { McpToolRouter } from "../src/mcp/McpToolRouter";
import { PolicyEngine } from "../src/policy/PolicyEngine";
import { ToolRegistry } from "../src/tools/ToolRegistry";
import { ExecutionTraceService } from "../src/execution/ExecutionTrace";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  console.log("--- Testing Conversation Ownership Lifecycle ---");

  const dbAdapter = AdapterFactory.getAdapter();
  const memoryService = new MemoryService(dbAdapter);
  const toolRegistry = new ToolRegistry();
  const policyEngine = new PolicyEngine(toolRegistry);
  const traceService = new ExecutionTraceService(dbAdapter);
  const mcpRouter = new McpToolRouter(policyEngine, traceService, toolRegistry);
  const agentManager = new AgentManager(memoryService, mcpRouter, policyEngine, traceService);
  const takeoverManager = new TakeoverManager();

  const orchestrator = new Orchestrator(memoryService, agentManager, takeoverManager);

  const senderId = "U6256f0c1dbb64edacf9cca92904e49b1"; // existing line user
  const channel = "line";

  // 1. Get conversation ID
  const sessionContext = await dbAdapter.loadSessionContext(senderId, channel);
  const conversationId = sessionContext.conversationId;
  console.log(`Using Conversation ID: ${conversationId}`);

  // 2. Set takeover state to active human (valid for 10 seconds)
  console.log("\n1. Simulating Admin Takeover (10s session)...");
  await dbAdapter.updateHandoffState(conversationId, "human");
  takeoverManager.setTakeoverState(conversationId, "ACTIVE_HUMAN", "human_agent_admin", 10000);

  let state = takeoverManager.getTakeoverState(conversationId);
  console.log("Takeover State:", {
    status: state.status,
    human_session_started_at: state.human_session_started_at,
    human_session_expire_at: state.human_session_expire_at,
  });

  // Verify DB handoff state
  let dbSession = await dbAdapter.loadSessionContext(senderId, channel);
  console.log(`Database handled_by: ${dbSession.handledBy} (Expected: human)`);

  // 3. Simulate human reply (refresh session to 20 seconds from now, set last reply)
  console.log("\n2. Simulating Human Reply (refreshes session to 20s)...");
  takeoverManager.setTakeoverState(conversationId, "ACTIVE_HUMAN", "human_agent_admin", 20000, true);
  state = takeoverManager.getTakeoverState(conversationId);
  console.log("Takeover State after reply:", {
    status: state.status,
    last_human_reply_at: state.last_human_reply_at,
    human_session_expire_at: state.human_session_expire_at,
  });

  // 4. Force session expiration (expire lease in the past)
  console.log("\n3. Simulating Session Expiration...");
  takeoverManager.setTakeoverState(conversationId, "ACTIVE_HUMAN", "human_agent_admin", -5000); // 5s in past
  state = takeoverManager.getTakeoverState(conversationId);
  console.log("Takeover State before incoming message check:", {
    status: state.status, // should be ACTIVE_AI because getTakeoverState lazy-runs checkLease!
  });

  // 5. Simulate incoming customer message to trigger Orchestrator expiration logic
  console.log("\n4. Injecting incoming customer message...");
  const reply = await orchestrator.handleIncomingMessage({
    senderId,
    channel,
    text: "สวัสดีครับ",
    timestamp: new Date().toISOString(),
  });

  console.log("Orchestrator reply:", reply);

  // 6. Check NocoDB state again (should be back to ai)
  dbSession = await dbAdapter.loadSessionContext(senderId, channel);
  console.log(`\nFinal Database handled_by: ${dbSession.handledBy} (Expected: ai)`);
}

run().catch(console.error);
