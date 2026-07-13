import { pool } from "./adapters/postgres/PostgresAdapter";
import { TransactionManager } from "./shared/repositories/TransactionManager";
import { UnitOfWork } from "./shared/repositories/UnitOfWork";
import { Ticket } from "./domain/entities/Ticket";
import { TicketCreatedEvent } from "./domain/entities/TicketEvents";
import { PostgresTicketRepository } from "./infrastructure/db/PostgresTicketRepository";
import { PostgresTicketEventRepository } from "./infrastructure/db/PostgresTicketEventRepository";
import { PostgresTicketEmbeddingRepository } from "./infrastructure/db/PostgresTicketEmbeddingRepository";
import { TicketEmbeddingEntity } from "./domain/entities/TicketEmbeddingEntity";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function runTests() {
  console.log("============================================================");
  console.log("             AX-BE-050 & AX-BE-051 PR1 Tests                ");
  console.log("============================================================\n");

  const txManager = new TransactionManager();
  const uow = new UnitOfWork(txManager);
  const ticketRepo = new PostgresTicketRepository(txManager);
  const eventRepo = new PostgresTicketEventRepository(txManager);
  const embeddingRepo = new PostgresTicketEmbeddingRepository(txManager);

  // 1. Migration Verification
  console.log("Running Test 1: Migration and Schema Verification...");
  const { rows: columns } = await pool.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'tickets' 
      AND column_name IN ('title', 'duplicate_of_ticket_id', 'duplicate_score', 'ai_confidence_metrics');
  `);
  assert(columns.length === 4, "Missing newly migrated columns on tickets table");

  // Verify ticket_events table
  const { rows: eventTable } = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'ticket_events'
    );
  `);
  assert(eventTable[0].exists === true, "ticket_events table does not exist");
  console.log("✔ Test 1 Passed.\n");

  // 2. Idempotent Migration Verification
  console.log("Running Test 2: Idempotent Migration Execution...");
  // Re-run migration script directly
  const fs = await import("fs");
  const path = await import("path");
  const sqlFile = path.resolve(__dirname, "../database/migrations/010_ticket_intelligence_v2.sql");
  const sqlContent = fs.readFileSync(sqlFile, "utf8");

  let threwMigrationError = false;
  try {
    await pool.query(sqlContent);
  } catch (err: any) {
    threwMigrationError = true;
    console.error("Migration re-run failed:", err.message);
  }
  assert(!threwMigrationError, "Migration is not idempotent");
  console.log("✔ Test 2 Passed.\n");

  // 3. Domain Aggregate Validation Rules
  console.log("Running Test 3: Ticket Domain Aggregate Validations...");
  
  // A. Create Ticket
  const ticket = Ticket.create({
    ticketId: "TCK-TEST-99901",
    conversationId: 1,
    projectId: 1,
    subject: "Active Directory Account Lockout",
    status: "open",
    priority: "P2",
    createdVia: "ai",
  });
  
  assert(ticket.id === 0, "New ticket ID must be 0");
  assert(ticket.domainEvents.length === 1, "Should have 1 event");
  assert(ticket.domainEvents[0] instanceof TicketCreatedEvent, "Event mismatch");

  // B. Assign PM
  ticket.assign("agent-77");
  assert(ticket.assignedPm === "agent-77", "Agent assignment failed");

  // C. Update Summary
  ticket.updateSummary("Running SSO loop issue", "Login fails periodically");
  assert(ticket.runningSummary === "Running SSO loop issue", "Running summary failed");

  // D. Invalid status transitions
  let threwTransitionError = false;
  try {
    ticket.changeStatus("resolved"); // open -> resolved is valid
    ticket.changeStatus("open");     // resolved -> open is valid
    ticket.changeStatus("closed");   // open -> closed is valid
    ticket.changeStatus("open");     // closed -> open is invalid
  } catch (err: any) {
    if (err.message.includes("Closed tickets cannot transition status")) {
      threwTransitionError = true;
    }
  }
  assert(threwTransitionError, "Aggregate failed to block status transition from closed");

  // E. Closed modifications guards
  let threwClosedAssignError = false;
  try {
    ticket.assign("agent-88");
  } catch (err: any) {
    if (err.message.includes("Cannot assign closed ticket")) {
      threwClosedAssignError = true;
    }
  }
  assert(threwClosedAssignError, "Aggregate failed to block assignment on closed ticket");

  // F. Cannot merge / duplicate of self
  const ticketToMerge = Ticket.create({
    id: 1234,
    ticketId: "TCK-TEST-1234",
    conversationId: 1,
    subject: "SSO login loop",
    status: "open",
  });
  
  let threwSelfMergeError = false;
  try {
    ticketToMerge.merge(1234);
  } catch (err: any) {
    if (err.message.includes("Cannot merge a ticket into itself")) {
      threwSelfMergeError = true;
    }
  }
  assert(threwSelfMergeError, "Aggregate failed to block self merge");

  let threwSelfDuplicateError = false;
  try {
    ticketToMerge.markDuplicate(1234, 0.95, "Identical issue");
  } catch (err: any) {
    if (err.message.includes("A ticket cannot be a duplicate of itself")) {
      threwSelfDuplicateError = true;
    }
  }
  assert(threwSelfDuplicateError, "Aggregate failed to block self duplicate marking");
  console.log("✔ Test 3 Passed.\n");

  // 4. Repository & UoW Transaction Operations
  console.log("Running Test 4: Repository and UnitOfWork Commit...");
  
  // Clear previous test records
  await pool.query("DELETE FROM ticket_embeddings WHERE ticket_id IN (SELECT id FROM tickets WHERE ticket_id IN ('TCK-TEST-99901', 'TCK-TEST-99902'))");
  await pool.query("DELETE FROM ticket_events WHERE ticket_id IN (SELECT id FROM tickets WHERE ticket_id IN ('TCK-TEST-99901', 'TCK-TEST-99902'))");
  await pool.query("DELETE FROM tickets WHERE ticket_id IN ('TCK-TEST-99901', 'TCK-TEST-99902')");

  const ticketToSave = Ticket.create({
    ticketId: "TCK-TEST-99901",
    conversationId: 1,
    projectId: 1,
    subject: "Active Directory Account Lockout",
    status: "open",
    priority: "P2",
  });
  ticketToSave.assign("agent-101");
  ticketToSave.updateSummary("Locked out of SSO", "Password lockout loop");

  let eventsPublished: any[] = [];
  
  await uow.execute(
    async () => {
      uow.registerAggregate(ticketToSave);
      await ticketRepo.save(ticketToSave);
      
      // Save timeline events inside transaction context
      await eventRepo.saveEvents(ticketToSave, "corr-uow-1", "AI", "Line");
    },
    async (events) => {
      eventsPublished = events;
    }
  );

  assert(ticketToSave.id > 0, "Persisted ticket should have positive database ID");
  assert(eventsPublished.length === 3, "UoW should have captured 3 events");
  assert(ticketToSave.domainEvents.length === 0, "Domain events must be cleared after successful transaction");

  // Verify timeline events persist in DB
  const savedEvents = await eventRepo.findByTicketId(ticketToSave.id);
  assert(savedEvents.length === 3, "Timeline events missing in database");
  assert(savedEvents[0].eventType === "TicketCreatedEvent", "Event type mismatch");
  assert(savedEvents[1].eventType === "TicketAssignedEvent", "Event type mismatch");
  assert(savedEvents[2].eventType === "TicketSummaryUpdatedEvent", "Event type mismatch");
  console.log("✔ Test 4 Passed.\n");

  // 5. Rollback Verification
  console.log("Running Test 5: Rollback on Error...");
  const ticketToRollback = Ticket.create({
    ticketId: "TCK-TEST-99902",
    conversationId: 1,
    projectId: 1,
    subject: "SSO Login Loop Error",
    status: "open",
    priority: "P2",
  });

  let threwUowError = false;
  try {
    await uow.execute(
      async () => {
        uow.registerAggregate(ticketToRollback);
        await ticketRepo.save(ticketToRollback);
        await eventRepo.saveEvents(ticketToRollback, "corr-uow-2", "AI", "Line");
        throw new Error("Simulated Rollback Error");
      }
    );
  } catch (err: any) {
    if (err.message === "Simulated Rollback Error") {
      threwUowError = true;
    }
  }

  assert(threwUowError, "UoW did not throw transaction exception");
  
  // Verify it was rolled back and does not exist in DB
  const rolledBackTicket = await ticketRepo.findByTicketId("TCK-TEST-99902");
  assert(rolledBackTicket === null, "Rolled back ticket record should not exist in database");
  console.log("✔ Test 5 Passed.\n");

  // 6. Embedding Repository Verification
  console.log("Running Test 6: Ticket Embeddings Operations...");
  const embedEntity = new TicketEmbeddingEntity({
    id: 0,
    ticketId: ticketToSave.id,
    embedding: [0.123, -0.456, 0.789],
  });

  await uow.execute(async () => {
    await embeddingRepo.save(embedEntity);
  });

  // Verify embedding can be retrieved
  const retrievedEmbed = await embeddingRepo.findByTicketId(ticketToSave.id);
  assert(retrievedEmbed !== null, "Embedding should be found in database");
  assert(retrievedEmbed!.embedding[0] === 0.123, "Embedding content mismatch");

  // Delete embedding
  await uow.execute(async () => {
    await embeddingRepo.delete(ticketToSave.id);
  });

  const deletedEmbed = await embeddingRepo.findByTicketId(ticketToSave.id);
  assert(deletedEmbed === null, "Embedding should be null after deletion");
  console.log("✔ Test 6 Passed.\n");

  console.log("============================================================");
  console.log("               All PR1 Tests Passed!                        ");
  console.log("============================================================");
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Test Suite Failed:");
    console.error(err);
    process.exit(1);
  });
