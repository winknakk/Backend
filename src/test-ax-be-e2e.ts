import "./test-env-setup";
import Redis from "ioredis";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { TransactionManager } from "./shared/repositories/TransactionManager";
import { UnitOfWork } from "./shared/repositories/UnitOfWork";
import { Ticket } from "./domain/entities/Ticket";
import { PostgresTicketRepository } from "./infrastructure/db/PostgresTicketRepository";
import { PostgresTicketEventRepository } from "./infrastructure/db/PostgresTicketEventRepository";
import { TicketService } from "./tools/TicketService";
import { OutboxProcessor } from "./infrastructure/db/OutboxProcessor";
import { PostgresAdapter } from "./adapters/postgres/PostgresAdapter";
import { config } from "./config/env";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runE2ETests() {
  console.log("============================================================");
  console.log("             AX-BE-052 E2E Ticket Lifecycle Tests            ");
  console.log("============================================================\n");

  const redis = new Redis(config.REDIS_URL);
  const txManager = new TransactionManager();
  const ticketRepo = new PostgresTicketRepository(txManager);
  
  // Enable the event dispatcher
  process.env.ENABLE_BULLMQ_EVENT_DISPATCHER = "true";

  // Clean test records
  console.log("Cleaning up test records...");
  await redis.flushdb();
  await pool.query("DELETE FROM outbox_events WHERE event_type = 'TicketCreated'");
  await pool.query("DELETE FROM ticket_events WHERE ticket_id IN (SELECT id FROM tickets WHERE ticket_id LIKE 'TCK-E2E-%')");
  await pool.query("DELETE FROM tickets WHERE ticket_id LIKE 'TCK-E2E-%'");
  await pool.query("DELETE FROM conversations WHERE id = 99");

  // Mock conversation for FK constraint
  await pool.query("INSERT INTO conversations (id, project_id, identity_id, status, channel) VALUES (99, 1, 1, 'open', 'LINE')");

  // 1. Initialize Workers and Outbox
  console.log("Booting queue workers and Outbox poller...");
  const { TicketWorkersManager } = require("./application/jobs/TicketWorkersManager");
  TicketWorkersManager.start();
  const outboxProcessor = new OutboxProcessor();

  // Test 1: Successful Ticket Ingest & Integration Event dispatch
  console.log("\nRunning Test 1: End-to-End Ingress and AI Enrichment...");
  const adapter = new PostgresAdapter();
  const ticketService = new TicketService(adapter);

  const result = await ticketService.createTicket({
    projectId: "1",
    conversationId: "99",
    subject: "VPN authentication timeout error",
    summary: "User cannot connect to corporate VPN since 9 AM.",
    priority: "P1",
    severity: "high"
  });

  assert(result.success === true, "Ticket service creation should be successful");
  const ticketNumber = result.data.ticketId;
  console.log(`Created ticket: ${ticketNumber}`);

  // Wait for worker processing to finish asynchronously (AI Title & Duplicate check)
  console.log("Waiting for background workers to execute title and duplicate check jobs...");
  await sleep(1500);

  // Load ticket from database
  const ticketFromDb = await ticketRepo.findByTicketId(ticketNumber);
  assert(ticketFromDb !== null, "Ticket should exist in database");
  assert(ticketFromDb!.title === "AI Title: VPN authentication timeout error", `Title mismatch: ${ticketFromDb!.title}`);
  console.log("✔ AI Title generated successfully.");

  // Test 2: Outbox Processing & Plane.io Sync Job Dispatch
  console.log("\nRunning Test 2: Transactional Outbox poller & Plane Sync...");
  
  // Verify that an outbox event exists in pending status
  const { rows: pendingOutbox } = await pool.query(
    "SELECT id, status FROM outbox_events WHERE event_type = 'TicketCreated' AND status = 'pending' LIMIT 1"
  );
  assert(pendingOutbox.length > 0, "Pending outbox event should exist in database");
  const outboxId = pendingOutbox[0].id;
  console.log(`Found pending outbox event ID: ${outboxId}`);

  // Run outbox processor to poll the database, enqueue job, and mark outbox processed
  await outboxProcessor.processPendingEvents();

  // Poll database to verify outbox status changed to processed
  const { rows: processedOutbox } = await pool.query(
    "SELECT status FROM outbox_events WHERE id = $1",
    [outboxId]
  );
  assert(processedOutbox[0].status === "processed", `Outbox status should be processed, got: ${processedOutbox[0].status}`);
  console.log("✔ Outbox event processed successfully.");

  // Test 3: Transactional Rollback on DB Error
  console.log("\nRunning Test 3: Transactional Rollback and event bypass...");
  
  let failed = false;
  try {
    // Intentionally violate DB constraint inside transaction (e.g. non-existent conversation ID)
    await txManager.executeTransaction(async () => {
      const invalidTicket = Ticket.create({
        ticketId: "TCK-E2E-ROLLBACK",
        conversationId: 999999, // Fails foreign key constraint
        projectId: 1,
        subject: "Should Rollback",
        status: "Open",
        priority: "P2"
      });
      await ticketRepo.save(invalidTicket);
    });
  } catch (err: any) {
    failed = true;
    console.log(`Expected transaction fail caught: ${err.message}`);
  }

  assert(failed === true, "Transaction must fail and trigger rollback");
  
  // Verify that no ticket TCK-E2E-ROLLBACK exists in database
  const rollbackTicket = await ticketRepo.findByTicketId("TCK-E2E-ROLLBACK");
  assert(rollbackTicket === null, "Rolled-back ticket must not be written to DB");
  console.log("✔ Database transaction rollback verified successfully.");

  // Clean shutdown
  console.log("\nStopping job queue and workers...");
  await TicketWorkersManager.stop();
  await redis.quit();

  console.log("\n============================================================");
  console.log("               All E2E Tests Passed!                        ");
  console.log("============================================================\n");
}

runE2ETests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ E2E Test Suite Failed:");
    console.error(err);
    process.exit(1);
  });
