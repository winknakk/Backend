import { pool } from "./adapters/postgres/PostgresAdapter";
import { TransactionManager } from "./shared/repositories/TransactionManager";
import { PostgresConversationEventStore } from "./infrastructure/db/PostgresConversationEventStore";
import { TakeoverStartedEvent, TakeoverEndedEvent } from "./domain/entities/ConversationEvent";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function runTests() {
  console.log("============================================================");
  console.log("             AX-BE-038 Postgres Event Store Tests            ");
  console.log("============================================================\n");

  const txManager = new TransactionManager();
  const eventStore = new PostgresConversationEventStore(txManager);

  // Clear previous test events to ensure clean state
  await pool.query("DELETE FROM conversation_events WHERE conversation_id = 999");
  await pool.query("DELETE FROM conversations WHERE id = 999");

  // Seed conversation 999 to satisfy foreign key constraint
  await pool.query(
    `INSERT INTO conversations (id, project_id, identity_id, status, handled_by, channel)
     VALUES (999, 1, 12, 'open', 'ai', 'WebChat')`
  );

  // 1. Save single domain event
  console.log("Running Test 1: Save single domain event...");
  const event1 = new TakeoverStartedEvent("999", "agent-1", 30 * 60 * 1000);
  await eventStore.saveEvent(event1, "corr-test-1");

  // Verify event persists in database
  const events = await eventStore.getEventsByConversationId("999");
  assert(events.length === 1, "Should have loaded exactly 1 event");
  assert((events[0] as any).eventType === "TakeoverStartedEvent", "Event type mismatch");
  assert((events[0] as any).agentId === "agent-1", "Serialized field agentId mismatch");
  console.log("✔ Test 1 Passed.\n");

  // 2. Save multiple domain events inside transaction boundary
  console.log("Running Test 2: Save multiple events inside transaction...");
  const event2 = new TakeoverEndedEvent("999");
  const event3 = new TakeoverStartedEvent("999", "agent-2", 10 * 60 * 1000);

  await txManager.executeTransaction(async () => {
    await eventStore.saveEvents([event2, event3], "corr-test-2");
  });

  // Verify all events are present and loaded chronologically
  const allEvents = await eventStore.getEventsByConversationId("999");
  assert(allEvents.length === 3, "Should have loaded exactly 3 events");
  assert((allEvents[0] as any).eventType === "TakeoverStartedEvent", "Event 1 mismatch");
  assert((allEvents[1] as any).eventType === "TakeoverEndedEvent", "Event 2 mismatch");
  assert((allEvents[2] as any).eventType === "TakeoverStartedEvent", "Event 3 mismatch");
  assert((allEvents[2] as any).agentId === "agent-2", "Event 3 agentId mismatch");
  console.log("✔ Test 2 Passed.\n");

  console.log("============================================================");
  console.log("              All AX-BE-038 Tests Passed!                   ");
  console.log("============================================================");
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Test Suite Failed:");
    console.error(err);
    process.exit(1);
  });
