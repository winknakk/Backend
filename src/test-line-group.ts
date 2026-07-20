import dotenv from "dotenv";
dotenv.config();

import { InboundMessageSchema, OutboundMessageSchema } from "./schemas/validation";
import { Orchestrator } from "./orchestrator/Orchestrator";
import { AgentManager } from "./agent/AgentRuntime";
import { McpToolRouter } from "./mcp/McpToolRouter";
import { PolicyEngine } from "./policy/PolicyEngine";
import { ToolRegistry } from "./tools/ToolRegistry";
import { ExecutionTraceService } from "./execution/ExecutionTrace";
import { TakeoverManager } from "./human-takeover/TakeoverManager";
import { MemoryService } from "./memory/MemoryService";
import * as path from "path";
import * as fs from "fs";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log("=========================================");
  console.log("    LINE Group and Message Uniqueness    ");
  console.log("            Verification Tests           ");
  console.log("=========================================\n");

  // 1. Validate Schema parsing for line_group
  console.log("1. Testing Zod payload schemas...");
  const sample1 = InboundMessageSchema.parse({
    senderId: "test-user-line",
    channel: "line_group",
    text: "Bot hello!",
    receivedAt: new Date().toISOString(),
    externalId: "LINE_EVT_001",
  });
  console.log("   - channel: 'line_group' and externalId parsed successfully");

  const sample2 = InboundMessageSchema.parse({
    senderId: "test-user-line",
    channel: "LINE_GROUP",
    text: "Bot hello!",
    receivedAt: new Date().toISOString(),
    externalId: "LINE_EVT_002",
  });
  console.log("   - channel: 'LINE_GROUP' parsed successfully");

  const sample3 = OutboundMessageSchema.parse({
    recipientId: "test-user-line",
    channel: "line",
    text: "AI response text",
    sentAt: new Date().toISOString(),
    externalId: "ai_LINE_EVT_001",
  });
  console.log("   - Outbound message with 'line' and externalId parsed successfully");

  // Setup DB config
  const databaseUrl = process.env.DATABASE_URL || "postgresql://postgres:15969win@localhost:5432/postgres";
  process.env.DATABASE_URL = databaseUrl;
  
  const { PostgresAdapter, pool } = await import("./adapters/postgres/PostgresAdapter");
  const { runMigrations } = await import("./adapters/postgres/migrations");

  console.log("\n2. Connecting to database and running migrations...");
  await runMigrations(pool);

  const dbAdapter = new PostgresAdapter();
  const memoryService = new MemoryService(dbAdapter);

  // Clear or seed a company/project for session resolution
  const companyRes = await pool.query("SELECT id FROM companies LIMIT 1");
  let companyId = companyRes.rows[0]?.id;
  if (!companyId) {
    const insertRes = await pool.query("INSERT INTO companies (name) VALUES ('Test Corp') RETURNING id");
    companyId = insertRes.rows[0].id;
  }
  const companyIdStr = companyId.toString();

  // Clean test target conversation data
  const testSender = "LINE_GROUP_TEST_SENDER";
  await pool.query(
    "DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE identity_id IN (SELECT id FROM identities WHERE channel_ref = $1))",
    [testSender]
  );
  await pool.query(
    "DELETE FROM conversations WHERE identity_id IN (SELECT id FROM identities WHERE channel_ref = $1)",
    [testSender]
  );

  // 3. Verify ensureConversation & loadSessionContext
  console.log("\n3. Testing channel resolution for 'line_group'...");
  const conversationId = await dbAdapter.ensureConversation(testSender, companyIdStr, "line_group");
  console.log(`   - Conversation created. ID: ${conversationId}`);
  assert(conversationId !== null && conversationId !== undefined, "Conversation ID cannot be empty");

  const context = await dbAdapter.loadSessionContext(testSender, "line_group");
  console.log(`   - Hydrated Session Context Channel: ${context.customerRef} handles 'line_group'`);
  assert(context.conversationId === conversationId, "Conversation ID must match context");

  // 4. Verify composite deduplication
  console.log("\n4. Testing composite message deduplication...");
  const externalId1 = "LINE_EVT_UNIQ_999";
  
  // First insert
  const firstInsert = await dbAdapter.saveMessage(conversationId, "customer", "Original unique text", externalId1);
  console.log(`   - First message inserted, content: "${firstInsert.content}"`);

  // Second insert (same conversation_id and external_id)
  const secondInsert = await dbAdapter.saveMessage(conversationId, "customer", "Duplicate text updated", externalId1);
  console.log(`   - Second duplicate message inserted, content: "${secondInsert.content}"`);

  // Verify only 1 message exists with this external_id in DB
  const { rows: duplicateCheck } = await pool.query(
    "SELECT * FROM messages WHERE conversation_id = $1 AND external_id = $2",
    [conversationId, externalId1]
  );
  console.log(`   - Found ${duplicateCheck.length} message(s) in DB for external_id "${externalId1}"`);
  assert(duplicateCheck.length === 1, "Uniqueness violation: duplicate external_id allowed in same conversation!");
  assert(duplicateCheck[0].content === "Duplicate text updated", "Content was not updated correctly by ON CONFLICT block");

  // 5. Verify Takeover Muting and externalId forwarding
  console.log("\n5. Testing Takeover Muting and externalId forwarding in Orchestrator...");
  const dataDir = path.resolve(__dirname, "../data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const takeoverFilePath = path.join(dataDir, "test_takeover_states_line_group.json");
  if (fs.existsSync(takeoverFilePath)) {
    try { fs.unlinkSync(takeoverFilePath); } catch {}
  }

  const toolRegistry = new ToolRegistry();
  const policyEngine = new PolicyEngine(toolRegistry);
  const traceService = new ExecutionTraceService(dbAdapter);
  const mcpToolRouter = new McpToolRouter(policyEngine, traceService, toolRegistry);
  const agentManager = new AgentManager(memoryService, mcpToolRouter, policyEngine, traceService);
  const takeoverManager = new TakeoverManager(takeoverFilePath, 5000);
  const orchestrator = new Orchestrator(memoryService, agentManager, takeoverManager);

  // Set takeover to ACTIVE_HUMAN
  await takeoverManager.setTakeoverState(conversationId, "ACTIVE_HUMAN", "agent_bob", 5000);
  console.log("   - Set takeover state to ACTIVE_HUMAN for conversation ID:", conversationId);

  // Send message through Orchestrator
  const customerInbound = {
    senderId: testSender,
    channel: "line_group" as const,
    text: "Handoff test message",
    receivedAt: new Date().toISOString(),
    externalId: "LINE_EVT_TAKEOVER_101",
  };

  const response = await orchestrator.handleIncomingMessage(customerInbound);
  console.log("   - Orchestrator reply:", response.text);
  assert(response.text.includes("Room Status: ACTIVE_HUMAN"), "AI must be muted during human takeover!");

  // Verify that the message was saved in DB with the correct externalId
  const { rows: takeoverCheck } = await pool.query(
    "SELECT * FROM messages WHERE conversation_id = $1 AND external_id = $2",
    [conversationId, "LINE_EVT_TAKEOVER_101"]
  );
  console.log(`   - Found customer message with external_id in DB: "${takeoverCheck[0]?.content}"`);
  assert(takeoverCheck.length === 1, "Customer message with externalId was not persisted under takeover!");

  // Cleanup
  if (fs.existsSync(takeoverFilePath)) {
    try { fs.unlinkSync(takeoverFilePath); } catch {}
  }
  await takeoverManager.disconnect();
  await pool.end();

  console.log("\n✅ All LINE Group and Uniqueness tests PASSED successfully!");
}

run().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
