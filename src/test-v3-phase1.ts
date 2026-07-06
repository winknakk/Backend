import * as fs from "fs";
import * as path from "path";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { Conversation } from "./domain/entities/Conversation";
import { Ticket } from "./domain/entities/Ticket";
import { runWithContext, getRequestContext, getProjectId, getCorrelationId } from "./kernel/context/RequestContextHolder";

function assert(condition: any, message: string): void {
  if (!condition) {
    throw new Error(`[Assertion Failed] ${message}`);
  }
}

// ============================================================
// 1. Unit Tests
// ============================================================
function runUnitTests(): void {
  console.log("Running Unit Tests...");

  // Test Conversation constructor and properties
  const conv = new Conversation({
    id: "conv-1",
    projectId: "100",
    identityId: "identity-1",
    status: "open",
    handledBy: "ai"
  });

  assert(conv.id === "conv-1", "Conversation ID mismatch");
  assert(conv.projectId === "100", "Conversation Project ID mismatch");
  assert(conv.identityId === "identity-1", "Conversation Identity ID mismatch");
  assert(conv.status === "open", "Default status should be open");
  assert(conv.handledBy === "ai", "Default handledBy should be ai");

  // Test takeover lease logic
  conv.initiateTakeover("agent-99", 5000);
  assert(conv.handledBy === "human", "handledBy should be human after takeover");
  assert(conv.assignedPm === "agent-99", "assignedPm should match takeover agent");
  assert(conv.takeoverExpiresAt instanceof Date, "takeoverExpiresAt must be a Date object");

  // Test releasing takeover lease
  conv.releaseTakeover();
  assert(conv.handledBy === "ai", "handledBy should revert to ai");
  assert(conv.takeoverExpiresAt === null, "takeoverExpiresAt should be null");

  // Test Ticket constructor validation
  try {
    new Ticket({
      id: "tck-1",
      ticketId: "TCK-1",
      conversationId: "conv-1",
      subject: "abc", // too short, subject must be >= 5 chars
      status: "open"
    });
    assert(false, "Should have failed due to short subject length");
  } catch (err: any) {
    assert(err.message.toLowerCase().includes("subject must be at least 5 characters"), "Expected subject length validation error");
  }

  // Test Ticket priority updates
  const ticket = new Ticket({
    id: "tck-1",
    ticketId: "TCK-1",
    conversationId: "conv-1",
    subject: "Valid Subject Line",
    status: "open",
    priority: "P4"
  });
  ticket.updatePriority("P1", 4);
  assert(ticket.priority === "P1", "Ticket priority was not updated");
  assert(ticket.dueDate instanceof Date, "Ticket due date was not generated");

  console.log("Unit Tests passed successfully.");
}

// ============================================================
// 2. Integration Tests
// ============================================================
async function runIntegrationTests(): Promise<void> {
  console.log("Running Integration Tests...");

  // Test RequestContext Thread Propagation via AsyncLocalStorage
  const testContext = {
    correlationId: "corr_test_1234",
    projectId: "999",
    clientChannel: "line",
    channelRef: "user_test_line"
  };

  await runWithContext(testContext, async () => {
    const ctx = getRequestContext();
    assert(ctx.correlationId === "corr_test_1234", "Correlation ID mismatch in thread");
    assert(getProjectId() === "999", "Project ID mismatch in thread");
    assert(getCorrelationId() === "corr_test_1234", "Correlation ID fallback mismatch");
  });

  // Verify Database Schema migrations exist
  try {
    const tablesCheck = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('project_prompts', 'project_sla_policies', 'project_channels', 'project_ai_settings')
    `);
    
    assert(tablesCheck.rows.length === 4, "Platform configuration tables are missing in the database schema");
    
    // Check tickets column addition
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'tickets' 
      AND column_name = 'project_id'
    `);
    assert(columnCheck.rows.length === 1, "project_id column was not added to the tickets table");
    
    console.log("Integration Tests passed successfully.");
  } catch (dbError: any) {
    console.error("Database Integration Test failed. Verify that database is online and migrations are run.");
    throw dbError;
  }
}

// ============================================================
// 3. Architecture Tests (Clean Architecture boundaries verification)
// ============================================================
function runArchitectureTests(): void {
  console.log("Running Architecture Tests...");

  const entitiesDir = path.resolve(__dirname, "domain/entities");
  const reposDir = path.resolve(__dirname, "domain/repositories");

  const checkImports = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".ts"));

    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), "utf-8");
      
      // Look for disallowed imports
      assert(!content.includes("from \"../../infrastructure/"), `Architecture violation in ${file}: Domain layer must not import from infrastructure`);
      assert(!content.includes("from \"../../presentation/"), `Architecture violation in ${file}: Domain layer must not import from presentation`);
      assert(!content.includes("from \"../../adapters/"), `Architecture violation in ${file}: Domain layer must not import from adapters`);
    }
  };

  checkImports(entitiesDir);
  checkImports(reposDir);

  console.log("Architecture Tests passed successfully.");
}

// ============================================================
// Main Test Runner Executable
// ============================================================
async function main() {
  console.log("============================================================");
  console.log("AutomationX V3 Phase 1 Platform Verification Test Runner");
  console.log("============================================================");
  try {
    runUnitTests();
    runArchitectureTests();
    await runIntegrationTests();
    console.log("============================================================");
    console.log("All V3 Phase 1 Verification Tests Passed!");
    console.log("============================================================");
    process.exit(0);
  } catch (err: any) {
    console.error("============================================================");
    console.error("Phase 1 Verification Tests Failed:", err.message);
    console.error("============================================================");
    process.exit(1);
  }
}

main();
