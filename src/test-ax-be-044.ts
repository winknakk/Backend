import { pool } from "./adapters/postgres/PostgresAdapter";
import { OutboxProcessor } from "./infrastructure/db/OutboxProcessor";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function runTests() {
  console.log("============================================================");
  console.log("             AX-BE-044 Outbox Processor Tests               ");
  console.log("============================================================\n");

  const processor = new OutboxProcessor();

  // Clear previous outbox entries for clean test run
  await pool.query("DELETE FROM outbox_events WHERE event_type = 'TestOutboxEvent'");
  await pool.query("DELETE FROM outbox_events WHERE payload::text LIKE '%\"ticketId\":9999%'");
  await pool.query("DELETE FROM outbox_events WHERE payload::text LIKE '%\"ticketId\":8888%'");
  await pool.query("DELETE FROM tickets WHERE id IN ('9999', '8888')");
  await pool.query("DELETE FROM conversations WHERE id IN (9999, 8888)");

  // Seed conversation and ticket to satisfy foreign key references in Plane promotion
  await pool.query(
    `INSERT INTO conversations (id, project_id, identity_id, status, handled_by, channel)
     VALUES (9999, 1, 12, 'open', 'ai', 'WebChat')`
  );

  await pool.query(
    `INSERT INTO tickets (id, conversation_id, subject, summary, status, priority)
     VALUES ('9999', 9999, 'Test SSO Issue', 'Unable to login to SSO portal', 'Open', 'High')`
  );

  // 1. Process Pending Outbox Event (TicketCreated)
  console.log("Running Test 1: Outbox Event Processing & Success Transition...");
  const payloadData = { ticketId: 9999 };
  const { rows: insertRes } = await pool.query(
    `INSERT INTO outbox_events (event_type, payload, status, attempts)
     VALUES ('TicketCreated', $1, 'pending', 0)
     RETURNING id`,
    [JSON.stringify(payloadData)]
  );
  const outboxId = insertRes[0].id;

  // Execute processing loop once
  await processor.processPendingEvents();

  // Verify status in DB is updated to 'processed'
  const { rows: processedRows } = await pool.query(
    `SELECT status, attempts, error_message FROM outbox_events WHERE id = $1`,
    [outboxId]
  );
  assert(processedRows[0].status === "processed", "Outbox status should have transitioned to 'processed'");
  assert(processedRows[0].attempts === 0, "Attempts should remain 0 on success");
  console.log("✔ Test 1 Passed.\n");

  // 2. Process Failed Outbox Event (Error handling)
  console.log("Running Test 2: Outbox Event Error & Retry Transition...");
  // Create an outbox event with a missing/invalid ticket ID to trigger a processing failure
  const badPayload = { ticketId: 8888 }; // Ticket 8888 does not exist
  const { rows: badInsertRes } = await pool.query(
    `INSERT INTO outbox_events (event_type, payload, status, attempts)
     VALUES ('TicketCreated', $1, 'pending', 0)
     RETURNING id`,
    [JSON.stringify(badPayload)]
  );
  const badOutboxId = badInsertRes[0].id;

  // Execute processing loop once
  await processor.processPendingEvents();

  // Verify status is still 'pending' but attempts has incremented
  const { rows: badRows } = await pool.query(
    `SELECT status, attempts, error_message FROM outbox_events WHERE id = $1`,
    [badOutboxId]
  );
  assert(badRows[0].status === "pending", "Outbox status should remain 'pending' for retry");
  assert(badRows[0].attempts === 1, "Attempts should have incremented to 1");
  assert(badRows[0].error_message !== null, "Error message should have been recorded");
  console.log("✔ Test 2 Passed.\n");

  console.log("============================================================");
  console.log("              All AX-BE-044 Tests Passed!                   ");
  console.log("============================================================");
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Test Suite Failed:");
    console.error(err);
    process.exit(1);
  });
