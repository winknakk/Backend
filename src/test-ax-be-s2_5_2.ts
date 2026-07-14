import "./test-env-setup";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { toolRegistry, bootstrap } from "./api/server";
import { McpToolRouter } from "./mcp/McpToolRouter";
import { PolicyEngine } from "./policy/PolicyEngine";
import { ExecutionTraceService } from "./execution/ExecutionTrace";
import { PostgresAdapter } from "./adapters/postgres/PostgresAdapter";
import { TicketService } from "./tools/TicketService";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function runTests() {
  console.log("============================================================");
  console.log("             Sprint 2.5-2 MCP Tool Contract Tests           ");
  console.log("============================================================\n");

  await bootstrap();

  const dbAdapter = new PostgresAdapter();
  const ticketService = new TicketService(dbAdapter);
  const policyEngine = new PolicyEngine(toolRegistry);
  const traceService = new ExecutionTraceService(dbAdapter);
  const router = new McpToolRouter(policyEngine, traceService, toolRegistry);

  // Setup policy allows
  policyEngine.registerRule({
    ruleId: "rule-allow-all",
    name: "Allow all test tools",
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
      "escalate_to_pm"
    ]
  });

  // Clean DB
  await pool.query("DELETE FROM ticket_events WHERE ticket_id IN (SELECT id FROM tickets WHERE ticket_id LIKE 'TCK-S252-%')");
  await pool.query("DELETE FROM tickets WHERE ticket_id LIKE 'TCK-S252-%'");
  await pool.query("DELETE FROM conversations WHERE id = 992");
  await pool.query("INSERT INTO conversations (id, project_id, identity_id, status, channel) VALUES (992, 1, 1, 'open', 'LINE')");

  const sessionContext = {
    sessionId: "session-1",
    activeAgentId: "test-agent",
    conversationId: "992",
    requestId: "req-1"
  };

  // Test 1: create_ticket via McpToolRouter
  console.log("Testing Tool: create_ticket...");
  const createResult = await router.callTool("create_ticket", {
    conversationId: "992",
    subject: "Sprint 2.5-2 MCP test",
    summary: "Checking if contract v2 returns enrichment status",
    severity: "medium",
    priority: "P3",
    projectId: "1"
  }, sessionContext);

  assert(createResult.success === true, `Create should be successful: ${createResult.error}`);
  assert(createResult.data.enrichmentState === "PENDING", "Ticket enrichment should start as PENDING");
  const ticketReadableId = createResult.data.ticketId;

  // Test 2: get_ticket_status
  console.log("Testing Tool: get_ticket_status...");
  const statusResult = await router.callTool("get_ticket_status", {
    ticketId: ticketReadableId
  }, sessionContext);
  assert(statusResult.success === true, `Get status failed: ${statusResult.error}`);
  assert(statusResult.data.enrichmentState === "PENDING", "Status should indicate PENDING enrichment");
  assert(statusResult.data.aiConfidenceMetrics.title === 0, "Initial metrics should be 0");

  // Test 3: get_ticket
  console.log("Testing Tool: get_ticket...");
  const getResult = await router.callTool("get_ticket", {
    ticketId: ticketReadableId
  }, sessionContext);
  assert(getResult.success === true, `Get ticket failed: ${getResult.error}`);
  assert(getResult.data.ticketId === ticketReadableId, "ID mismatch");
  assert(getResult.data.aiConfidenceMetrics.summary === 0, "Initial summary metrics should be 0");

  // Test 4: update_summary
  console.log("Testing Tool: update_summary...");
  const updateResult = await router.callTool("update_summary", {
    ticketId: ticketReadableId,
    runningSummary: "Updated running summary via manual PM override",
    lastAiSummary: "Updated AI summary"
  }, sessionContext);
  assert(updateResult.success === true, `Update summary failed: ${updateResult.error}`);

  // Test 5: get_ticket again to check updated fields
  console.log("Re-verifying via get_ticket...");
  const getUpdated = await router.callTool("get_ticket", {
    ticketId: ticketReadableId
  }, sessionContext);
  assert(getUpdated.data.runningSummary === "Updated running summary via manual PM override", "Summary was not updated");

  // Test 6: close_ticket
  console.log("Testing Tool: close_ticket...");
  const closeResult = await router.callTool("close_ticket", {
    ticketId: ticketReadableId
  }, sessionContext);
  assert(closeResult.success === true, `Close failed: ${closeResult.error}`);
  assert(closeResult.data.status === "closed", "Status should be closed");

  console.log("\nAll MCP Tool Contract Tests Passed!");
}

runTests().catch(err => {
  console.error("MCP contract tests failed:", err);
  process.exit(1);
});
