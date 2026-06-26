import { EvalTestRunner } from "./aiops/llmops/EvalTestRunner";
import { z } from "zod";
import { AgentManager } from "./agent/AgentRuntime";
import { LocalDataAdapter } from "./adapters/local-data/LocalDataAdapter";
import { EvalTestCase } from "./schemas/aiops";
import { McpToolRouter } from "./mcp/McpToolRouter";
import { PolicyEngine } from "./policy/PolicyEngine";
import { ToolRegistry } from "./tools/ToolRegistry";
import { ExecutionTraceService } from "./execution/ExecutionTrace";
import * as fs from "fs";
import * as path from "path";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log("=========================================");
  console.log("    AutomationX V2 Agent Evaluation Tests");
  console.log("=========================================");

  // Cleanup trace/ticket JSONs to start fresh
  const dataDir = path.resolve(__dirname, "../data");
  if (fs.existsSync(dataDir)) {
    const files = fs.readdirSync(dataDir);
    files.forEach((f) => {
      if (f.includes("Traces") || f.includes("Tickets") || f.includes("Conversations")) {
        try {
          fs.unlinkSync(path.join(dataDir, f));
        } catch {}
      }
    });
  }

  const dbAdapter = new LocalDataAdapter();
  const toolRegistry = new ToolRegistry();
  const policyEngine = new PolicyEngine(toolRegistry);
  const traceService = new ExecutionTraceService(dbAdapter);

  // Register default rules to allow tool calls
  policyEngine.registerRule({
    ruleId: "rule-allow-eval-tools",
    name: "Allow Evaluation Tools",
    type: "permission",
    action: "allow",
    mcpToolNames: ["create_ticket", "search_project_docs"],
  });

  // Mock Tool Registry with simple implementations so tests run cleanly
  toolRegistry.registerTool({
    definition: {
      name: "create_ticket",
      description: "Creates ticket",
      inputSchema: { type: "object", properties: {} },
    },
    inputSchema: z.any(),
    async execute() {
      return { success: true, data: { ticketId: "TCK-EVAL-123" } };
    },
  } as any);

  toolRegistry.registerTool({
    definition: {
      name: "search_project_docs",
      description: "Search project documents",
      inputSchema: { type: "object", properties: {} },
    },
    inputSchema: z.any(),
    async execute() {
      return { results: [{ source: "vector_store", content: "SSO is active", confidence: 0.95 }] };
    },
  } as any);

  const mcpToolRouter = new McpToolRouter(policyEngine, traceService, toolRegistry);
  const memoryService = {
    ensureConversation: async (senderId: string, companyId: string, channel: string) => {
      return await dbAdapter.ensureConversation(senderId, companyId, channel);
    },
    loadSessionContext: async (senderId: string, channel: string) => {
      return await dbAdapter.loadSessionContext(senderId, channel);
    },
    appendConversationLog: async () => {},
    getConversationHistory: async () => [],
    updateHandoffState: async () => {},
  } as any;

  const agentManager = new AgentManager(memoryService, mcpToolRouter, policyEngine, traceService);
  const evalRunner = new EvalTestRunner(agentManager, dbAdapter);

  // Define golden dataset
  const testCases: EvalTestCase[] = [
    {
      testCaseId: "tc-001",
      inputMessage: "Hello, I need some help.",
      expectedAgentId: "support",
      expectedToolCalls: [],
    },
    {
      testCaseId: "tc-002",
      inputMessage: "I want to open a ticket for SSO login failure.",
      expectedAgentId: "ticket",
      expectedToolCalls: ["create_ticket"],
    },
    {
      testCaseId: "tc-003",
      inputMessage: "Where can I find Orbit App SSO login manual?",
      expectedAgentId: "knowledge",
      expectedToolCalls: ["search_project_docs"],
    },
  ];

  const results = await evalRunner.runSuite(testCases, "1");
  console.log("Evaluation Results:", results);

  // Assertions
  assert(results.length === 3, "Should evaluate all 3 test cases.");

  const tc1 = results.find((r) => r.testCaseId === "tc-001");
  assert(tc1?.success === true, "Hello input should route to support and succeed.");
  assert(tc1?.actualAgentId === "support", "Hello input should have support as actualAgentId.");
  assert(tc1?.accuracyScore === 1.0, "tc-001 accuracy score should be 1.0.");

  const tc2 = results.find((r) => r.testCaseId === "tc-002");
  assert(tc2?.success === true, "ticket input should route to ticket and succeed.");
  assert(tc2?.actualAgentId === "ticket", "ticket input actualAgentId should be ticket.");
  assert(tc2?.actualToolCalls.includes("create_ticket"), "ticket input should execute create_ticket tool.");
  assert(tc2?.accuracyScore === 1.0, "tc-002 accuracy score should be 1.0.");

  const tc3 = results.find((r) => r.testCaseId === "tc-003");
  assert(tc3?.success === true, "SSO manual input should route to knowledge and succeed.");
  assert(tc3?.actualAgentId === "knowledge", "SSO manual input actualAgentId should be knowledge.");
  assert(
    tc3?.actualToolCalls.includes("search_project_docs"),
    "SSO manual input should execute search_project_docs tool."
  );
  assert(tc3?.accuracyScore === 1.0, "tc-003 accuracy score should be 1.0.");

  console.log("\n✅ All Agent Evaluation tests PASSED successfully!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
