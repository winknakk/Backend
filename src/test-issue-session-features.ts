import { pool } from "./adapters/postgres/PostgresAdapter";
import { RuntimeContextResolver } from "./services/RuntimeContextResolver";
import { IssueSessionBuilder } from "./runtime/IssueSessionBuilder";
import { IssueSessionResolver } from "./runtime/IssueSessionResolver";
import { McpToolRouter } from "./mcp/McpToolRouter";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function runTests() {
  console.log("=========================================");
  console.log("  IssueSession v2 L1 Cache & Flags Tests");
  console.log("=========================================\n");

  const mockContext = {
    conversationId: 888,
    identityId: 10,
    projectId: 1,
    handledBy: "ai" as const,
    channel: "LINE"
  };

  const mockConv = {
    id: 888,
    status: "open" as const,
    handledBy: "ai" as const,
    channel: "LINE"
  };

  // Test 1: L1 Request-Scoped Cache Verification
  console.log("Test 1: Verifying L1 request-scoped cache lookup...");
  
  let dbQueriesCount = 0;
  const originalQuery = pool.query;
  
  // Spy on pool.query
  pool.query = async function(text: any, params: any): Promise<any> {
    dbQueriesCount++;
    return {
      rows: [{
        conversation_id: 888,
        identity_id: 10,
        project_id: 1,
        handled_by: "ai",
        channel: "LINE",
        company_id: 1
      }]
    };
  } as any;

  const resolver = new RuntimeContextResolver({} as any);

  const session = new IssueSessionBuilder()
    .withContext(mockContext)
    .withConversation(mockConv)
    .build();

  await IssueSessionResolver.run(session, async () => {
    // First resolution (cache miss -> database query)
    const ctx1 = await resolver.resolveRuntimeContext(888);
    assert(ctx1 !== null, "Should resolve context");
    assert(dbQueriesCount === 1, `DB queries count should be 1 (miss), got ${dbQueriesCount}`);

    // Second resolution (cache hit -> no database query)
    const ctx2 = await resolver.resolveRuntimeContext(888);
    assert(ctx2 !== null, "Should resolve context");
    assert(dbQueriesCount === 1, `DB queries count should remain 1 (hit), got ${dbQueriesCount}`);
  });

  // Restore pool.query
  pool.query = originalQuery;
  console.log("✅ Passed! L1 cache correctly intercepted duplicate resolver requests.");

  // Test 2: McpToolRouter Gating Verification
  console.log("Test 2: Verifying McpToolRouter runtime flags check...");
  
  let policyEngineCalled = false;
  let traceServiceCalled = false;

  const mockPolicyEngine = {
    authorizeToolCall: async () => {
      policyEngineCalled = true;
      return { isAllowed: true, sanitizedParams: {} };
    }
  };

  const mockTraceService = {
    startTrace: async () => {
      traceServiceCalled = true;
      return "mock-trace-id";
    },
    failTrace: async () => {}
  };

  const mockRegistry = {
    getTool: () => ({})
  };

  const router = new McpToolRouter(mockPolicyEngine as any, mockTraceService as any, mockRegistry as any);

  const sessionWithToolBlocked = new IssueSessionBuilder()
    .withContext(mockContext)
    .withConversation(mockConv)
    .withFlags({ allowToolExecution: false }) // Tool disabled!
    .build();

  // Test block inside non-processing state or disabled flag
  await IssueSessionResolver.run(sessionWithToolBlocked, async () => {
    const res = await router.callTool("any_tool", {}, { sessionId: "sess-1", activeAgentId: "agent-1" });
    assert(res.success === false, "Tool call should be blocked by flags");
    assert(typeof res.error === "string" && res.error.includes("blocked by active IssueSession flags"), "Should yield flags error");
    assert(policyEngineCalled === false, "Policy engine should NOT have been queried");
    assert(traceServiceCalled === true, "Trace service should have started a deny trace");
  });

  console.log("✅ Passed! McpToolRouter correctly enforced session runtime permissions.");
  console.log("\nAll L1 Cache & Flags tests passed successfully!");
}

runTests().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
