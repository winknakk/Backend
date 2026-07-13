import "./test-env-setup";
import Redis from "ioredis";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { TransactionManager } from "./shared/repositories/TransactionManager";
import { UnitOfWork } from "./shared/repositories/UnitOfWork";
import { Ticket } from "./domain/entities/Ticket";
import { PostgresTicketRepository } from "./infrastructure/db/PostgresTicketRepository";
import { PostgresTicketEventRepository } from "./infrastructure/db/PostgresTicketEventRepository";
import { BullMQJobQueue } from "./infrastructure/queue/BullMQJobQueue";
import { SubjectMatchingDuplicateStrategy } from "./domain/strategies/DuplicateDetectionStrategy";
import { config } from "./config/env";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  console.log("============================================================");
  console.log("                AX-BE-052 PR2 Workers Tests                  ");
  console.log("============================================================\n");

  const redis = new Redis(config.REDIS_URL);
  const txManager = new TransactionManager();
  const ticketRepo = new PostgresTicketRepository(txManager);
  const eventRepo = new PostgresTicketEventRepository(txManager);

  // Clear previous test data
  console.log("Cleaning up test data...");
  await redis.flushdb();
  await pool.query("DELETE FROM outbox_events WHERE event_type = 'TicketCreated'");
  await pool.query("DELETE FROM ticket_events WHERE ticket_id IN (SELECT id FROM tickets WHERE ticket_id LIKE 'TCK-PR2-%')");
  await pool.query("DELETE FROM tickets WHERE ticket_id LIKE 'TCK-PR2-%'");
  await pool.query("DELETE FROM conversations WHERE id IN (10, 11)");
  
  // Create mock conversations to satisfy foreign key constraints
  await pool.query("INSERT INTO conversations (id, project_id, identity_id, status, channel) VALUES (10, 1, 1, 'open', 'LINE'), (11, 1, 1, 'open', 'LINE')");

  // Initialize and start background workers
  console.log("Initializing and starting BullMQ Ticket Workers...");
  const jobQueue = new BullMQJobQueue();

  // Clean queues completely to remove active locks or jobs
  await (jobQueue as any).queue.obliterate({ force: true });
  await (jobQueue as any).titleQueue.obliterate({ force: true });
  await (jobQueue as any).summaryQueue.obliterate({ force: true });
  await (jobQueue as any).duplicateQueue.obliterate({ force: true });
  await (jobQueue as any).planeSyncQueue.obliterate({ force: true });

  jobQueue.startTicketWorkers();

  // Wait 1 second for workers to fully connect to Redis
  await sleep(1000);

  // 1. Duplicate Detection Strategy Test
  console.log("Running Test 1: Duplicate Detection Strategy...");
  const baseTicket = new Ticket({
    id: 100,
    ticketId: "TCK-PR2-BASE",
    conversationId: 1,
    projectId: 1,
    subject: "Active Directory Lockout Issue",
    status: "open",
  });

  const matchingTicket = new Ticket({
    id: 101,
    ticketId: "TCK-PR2-MATCH",
    conversationId: 2,
    projectId: 1,
    subject: "Active Directory Lockout Issue", // Identical subject
    status: "open",
  });

  const uniqueTicket = new Ticket({
    id: 102,
    ticketId: "TCK-PR2-UNIQUE",
    conversationId: 3,
    projectId: 1,
    subject: "Billing invoices missing",
    status: "open",
  });

  const strategy = new SubjectMatchingDuplicateStrategy();

  const resMatch = await strategy.detectDuplicate(matchingTicket, [baseTicket]);
  assert(resMatch.isDuplicate === true, "Should detect duplicate for identical subjects");
  assert(resMatch.duplicateOfTicketId === 100, "Should reference correct base ticket ID");

  const resSelf = await strategy.detectDuplicate(baseTicket, [baseTicket]);
  assert(resSelf.isDuplicate === false, "Should ignore self matching");

  const resUnique = await strategy.detectDuplicate(uniqueTicket, [baseTicket]);
  assert(resUnique.isDuplicate === false, "Should ignore non-matching subjects");
  console.log("✔ Test 1 Passed.\n");

  // 2. TicketTitleGeneratorWorker Test
  console.log("Running Test 2: AI Title Generation Worker...");
  
  // Create a ticket in database
  const uow = new UnitOfWork(txManager);
  const ticketObj = Ticket.create({
    ticketId: "TCK-PR2-T1",
    conversationId: 10,
    projectId: 1,
    subject: "Exchange mail synchronization failure",
    status: "open",
    priority: "P2",
  });

  await uow.execute(async () => {
    uow.registerAggregate(ticketObj);
    await ticketRepo.save(ticketObj);
  });

  // Enqueue title generation job
  const requestId = `req-title-${Date.now()}`;
  await jobQueue.enqueue({
    type: "ticket.title.generate",
    data: {
      ticketId: ticketObj.id,
      projectId: 1,
    },
    metadata: {
      requestId,
    },
  });

  // Poll database until title is updated
  console.log("Waiting for AI Title generation worker...");
  let updatedTitle = "";
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const dbTicket = await ticketRepo.findById(ticketObj.id);
    if (dbTicket && dbTicket.title) {
      updatedTitle = dbTicket.title;
      break;
    }
  }

  assert(updatedTitle === "AI Title: Exchange mail synchronization failure", `AI Title mismatch: ${updatedTitle}`);
  console.log("✔ Test 2 Passed.\n");

  // 3. TicketSummaryWorker Test
  console.log("Running Test 3: Ticket Summary Update Worker...");
  
  // Enqueue summary update job
  const summaryRequestId = `req-sum-${Date.now()}`;
  await jobQueue.enqueue({
    type: "ticket.summary.update",
    data: {
      ticketId: ticketObj.id,
      projectId: 1,
      messageText: "Cannot receive emails since this morning.",
    },
    metadata: {
      requestId: summaryRequestId,
    },
  });

  // Poll database until summary is updated
  console.log("Waiting for Ticket Summary update worker...");
  let updatedSummary = "";
  let confidenceSummary = 0;
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const dbTicket = await ticketRepo.findById(ticketObj.id);
    if (dbTicket && dbTicket.runningSummary) {
      updatedSummary = dbTicket.runningSummary;
      confidenceSummary = dbTicket.aiConfidenceMetrics.summary;
      break;
    }
  }

  assert(updatedSummary.includes("Cannot receive emails since this morning."), "Summary was not updated");
  assert(confidenceSummary === 0.95, "Summary confidence metric was not updated");
  console.log("✔ Test 3 Passed.\n");

  // 4. DuplicateDetectorWorker Test
  console.log("Running Test 4: Duplicate Detector Worker...");

  // Create a matching ticket in DB
  const duplicateTicketObj = Ticket.create({
    ticketId: "TCK-PR2-T2",
    conversationId: 11,
    projectId: 1,
    subject: "Exchange mail synchronization failure", // Matching subject
    status: "open",
    priority: "P2",
  });

  await uow.execute(async () => {
    uow.registerAggregate(duplicateTicketObj);
    await ticketRepo.save(duplicateTicketObj);
  });

  // Enqueue duplicate detection job
  const dupRequestId = `req-dup-${Date.now()}`;
  await jobQueue.enqueue({
    type: "ticket.duplicate.check",
    data: {
      ticketId: duplicateTicketObj.id,
      projectId: 1,
    },
    metadata: {
      requestId: dupRequestId,
    },
  });

  // Poll database until status transitions to merged
  console.log("Waiting for Duplicate Detector worker...");
  let updatedStatus = "";
  let duplicateOfId: number | null = null;
  let dupConfidence = 0;
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const dbTicket = await ticketRepo.findById(duplicateTicketObj.id);
    if (dbTicket && dbTicket.status === "merged") {
      updatedStatus = dbTicket.status;
      duplicateOfId = dbTicket.duplicateOfTicketId || null;
      dupConfidence = dbTicket.aiConfidenceMetrics.duplicate;
      break;
    }
  }

  assert(updatedStatus === "merged", "Ticket status was not transitioned to merged");
  assert(duplicateOfId === ticketObj.id, `Should reference first ticket ID: ${ticketObj.id}`);
  assert(dupConfidence === 1.00, "Duplicate confidence metric mismatch");
  console.log("✔ Test 4 Passed.\n");

  // 5. PlaneSyncWorker Outbox Sync Test
  console.log("Running Test 5: PlaneSyncWorker Outbox Sync...");

  // Manually insert a pending outbox event for the created ticket
  const outboxPayload = { ticketId: ticketObj.ticketId };
  const { rows: outboxRows } = await pool.query(
    `INSERT INTO outbox_events (event_type, payload, status, attempts)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ["TicketCreated", JSON.stringify(outboxPayload), "pending", 0]
  );
  const outboxEventId = outboxRows[0].id;

  // Enqueue outbox plane sync job
  const syncRequestId = `req-sync-${Date.now()}`;
  await jobQueue.enqueue({
    type: "ticket.sync.plane",
    data: {
      projectId: 1,
    },
    metadata: {
      requestId: syncRequestId,
    },
  });

  // Poll database until outbox status transitions to processed
  console.log("Waiting for PlaneSyncWorker...");
  let outboxStatus = "";
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const { rows } = await pool.query("SELECT status FROM outbox_events WHERE id = $1", [outboxEventId]);
    if (rows.length > 0 && rows[0].status === "processed") {
      outboxStatus = rows[0].status;
      break;
    }
  }

  assert(outboxStatus === "processed", "Outbox event was not marked as processed by PlaneSyncWorker");
  console.log("✔ Test 5 Passed.\n");

  // 6. Dead Letter Queue (DLQ) Exhaustion Test
  console.log("Running Test 6: Dead Letter Queue (DLQ) Retry Exhaustion...");

  // Enqueue a job that is guaranteed to throw error in title worker (invalid ticket ID)
  const dlqRequestId = `req-dlq-${Date.now()}`;
  await jobQueue.enqueue({
    type: "ticket.title.generate",
    data: {
      ticketId: 9999999, // Non-existent ID, throws error
      projectId: 1,
    },
    metadata: {
      requestId: dlqRequestId,
    },
  });

  // Poll DLQ list key in Redis until job is displaced there
  console.log("Waiting for retry exhaustion and displacement to DLQ in Redis...");
  let dlqRecordFound = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const dlqLen = await redis.llen("queue:jobs:dlq");
    if (dlqLen > 0) {
      const records = await redis.lrange("queue:jobs:dlq", 0, -1);
      const parsed = JSON.parse(records[0]);
      if (parsed.payload?.metadata?.requestId === dlqRequestId) {
        dlqRecordFound = true;
        assert(parsed.attemptsMade >= 3, "Job must exhaust retries before DLQ write");
        assert(parsed.error.includes("Ticket not found: 9999999"), "DLQ record should capture fail cause");
        break;
      }
    }
  }

  assert(dlqRecordFound, "Failed to capture displaced job context in Redis DLQ list key");
  console.log("✔ Test 6 Passed.\n");

  // Clean shutdown
  console.log("Stopping job queue and workers...");
  await jobQueue.disconnect();
  await redis.quit();

  console.log("============================================================");
  console.log("               All PR2 Tests Passed!                        ");
  console.log("============================================================");
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Test Suite Failed:");
    console.error(err);
    process.exit(1);
  });
