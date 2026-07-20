import dotenv from "dotenv";
dotenv.config();

import { InboundMessageSchema } from "./schemas/validation";
import { Orchestrator } from "./orchestrator/Orchestrator";
import { AgentManager } from "./agent/AgentRuntime";
import { McpToolRouter } from "./mcp/McpToolRouter";
import { PolicyEngine } from "./policy/PolicyEngine";
import { ToolRegistry } from "./tools/ToolRegistry";
import { ExecutionTraceService } from "./execution/ExecutionTrace";
import { TakeoverManager } from "./human-takeover/TakeoverManager";
import { MemoryService } from "./memory/MemoryService";
import { RedisSessionManager } from "./memory/RedisSessionManager";
import { ConversationResolver } from "./conversation/ConversationResolver";
import * as path from "path";
import * as fs from "fs";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log("=========================================");
  console.log("       Core Runtime & JIT Ticket        ");
  console.log("            Verification Tests           ");
  console.log("=========================================\n");

  const databaseUrl = process.env.DATABASE_URL || "postgresql://postgres:15969win@localhost:5432/postgres";
  process.env.DATABASE_URL = databaseUrl;
  
  const { PostgresAdapter, pool } = await import("./adapters/postgres/PostgresAdapter");
  const { runMigrations } = await import("./adapters/postgres/migrations");

  console.log("1. Connecting to database and running migrations...");
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
  const testGroupId = "LINE_GROUP_TEST_ROOM_ID";
  const testSender = "LINE_GROUP_TEST_USER_A";
  const testSenderB = "LINE_GROUP_TEST_USER_B";
  await pool.query(
    "DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE identity_id IN (SELECT id FROM identities WHERE channel_ref = $1))",
    [testGroupId]
  );
  await pool.query(
    "DELETE FROM conversations WHERE identity_id IN (SELECT id FROM identities WHERE channel_ref = $1)",
    [testGroupId]
  );

  const conversationId = await dbAdapter.ensureConversation(testGroupId, companyIdStr, "line_group");
  console.log(`   - Conversation resolved. ID: ${conversationId}`);

  // Initialize components
  const toolRegistry = new ToolRegistry();
  const policyEngine = new PolicyEngine(toolRegistry);
  const traceService = new ExecutionTraceService(dbAdapter);
  const mcpToolRouter = new McpToolRouter(policyEngine, traceService, toolRegistry);
  const agentManager = new AgentManager(memoryService, mcpToolRouter, policyEngine, traceService);
  const takeoverManager = new TakeoverManager();
  
  const redisSessionManager = new RedisSessionManager();
  const conversationResolver = new ConversationResolver(redisSessionManager);
  const orchestrator = new Orchestrator(memoryService, agentManager, takeoverManager, conversationResolver);

  // Ensure Redis session is clean
  await redisSessionManager.deleteSession(conversationId);

  // Scenario 1: Group message without mention from non-participant (A) -> Should be ignored
  console.log("\n2. Testing Group message without mention from non-participant...");
  const inbound1 = {
    senderId: testGroupId,
    senderRef: testSender,
    channel: "line_group" as const,
    text: "Can anyone help?",
    receivedAt: new Date().toISOString(),
    isMentioned: false,
    externalId: "LINE_EVT_001",
  };
  const response1 = await orchestrator.handleIncomingMessage(inbound1);
  console.log("   - Response:", response1.text);
  assert(response1.text.includes("Muted:"), "Should mute when no session exists");

  // Scenario 2: Group message with mention from User A -> Should create session and reply
  console.log("\n3. Testing Group message with mention from User A...");
  const inbound2 = {
    senderId: testGroupId,
    senderRef: testSender,
    channel: "line_group" as const,
    text: "@Bot VPN is broken error 500",
    receivedAt: new Date().toISOString(),
    isMentioned: true,
    externalId: "LINE_EVT_002",
  };
  const response2 = await orchestrator.handleIncomingMessage(inbound2);
  console.log("   - Response:", response2.text);
  assert(!response2.text.includes("Muted:"), "Should process when bot is mentioned");

  // Verify Redis session exists
  const session = await redisSessionManager.getSession(conversationId);
  console.log("   - Created session active participants:", session?.activeParticipants);
  assert(session !== null, "Session should exist");
  assert(!!session && session.activeParticipants.includes(testSender), "User A should be participant");

  // Verify JIT Ticket was created in DB for this conversation
  const activeTicket = await dbAdapter.getLatestTicketForConversation(conversationId);
  console.log("   - Created JIT Ticket:", activeTicket?.ticket_id, "-", activeTicket?.subject);
  assert(activeTicket !== null, "JIT Ticket should have been created");
  assert(activeTicket.subject.includes("Escalation"), "JIT ticket subject should match");

  // Scenario 3: Group message without mention from participant (User A) -> Should be allowed and reuse ticket
  console.log("\n4. Testing Group message without mention from active participant...");
  const inbound3 = {
    senderId: testGroupId,
    senderRef: testSender,
    channel: "line_group" as const,
    text: "How long will it take to fix?",
    receivedAt: new Date().toISOString(),
    isMentioned: false,
    externalId: "LINE_EVT_003",
  };
  const response3 = await orchestrator.handleIncomingMessage(inbound3);
  console.log("   - Response:", response3.text);
  assert(!response3.text.includes("Muted:"), "Participant should be allowed without mention");

  // Scenario 4: Group message without mention from non-participant (User B) -> Should be ignored
  console.log("\n5. Testing Group message without mention from non-participant User B...");
  const inbound4 = {
    senderId: testGroupId,
    senderRef: testSenderB,
    channel: "line_group" as const,
    text: "My connection is also down",
    receivedAt: new Date().toISOString(),
    isMentioned: false,
    externalId: "LINE_EVT_004",
  };
  const response4 = await orchestrator.handleIncomingMessage(inbound4);
  console.log("   - Response:", response4.text);
  assert(response4.text.includes("Muted:"), "User B should be muted until opting in");

  // Scenario 5: Group message with mention from User B -> Should add User B to session
  console.log("\n6. Testing Group message with mention from User B...");
  const inbound5 = {
    senderId: testGroupId,
    senderRef: testSenderB,
    channel: "line_group" as const,
    text: "@Bot me too, SSO fails",
    receivedAt: new Date().toISOString(),
    isMentioned: true,
    externalId: "LINE_EVT_005",
  };
  const response5 = await orchestrator.handleIncomingMessage(inbound5);
  console.log("   - Response:", response5.text);
  assert(!response5.text.includes("Muted:"), "User B should be allowed when mentioning");

  const sessionUpdated = await redisSessionManager.getSession(conversationId);
  console.log("   - Updated session active participants:", sessionUpdated?.activeParticipants);
  assert(sessionUpdated?.activeParticipants.includes(testSenderB), "User B should be added as participant");

  // Cleanup
  await redisSessionManager.deleteSession(conversationId);
  await takeoverManager.disconnect();
  await pool.end();

  console.log("\n✅ All Core Runtime & JIT Ticket tests PASSED successfully!");
}

run().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
