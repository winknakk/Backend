import { Conversation } from "./domain/entities/Conversation";
import { Message } from "./domain/entities/Message";
import { Profile } from "./domain/entities/Profile";
import {
  TakeoverStartedEvent,
  TakeoverEndedEvent,
  ConversationClosedEvent
} from "./domain/entities/ConversationEvent";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function runTests() {
  console.log("============================================================");
  console.log("             AX-BE-037 Domain Entities Tests                ");
  console.log("============================================================\n");

  // 1. Message & Profile entities
  console.log("Running Test 1: Message & Profile instantiation...");
  const msg = new Message({
    id: "msg-123",
    conversationId: "conv-1",
    role: "customer",
    content: "Hello AI Support",
    metadata: { source: "line" },
    messageType: "text",
  });

  assert(msg.id === "msg-123", "Message ID mismatch");
  assert(msg.role === "customer", "Message role mismatch");
  assert(msg.metadata.source === "line", "Message metadata mismatch");
  assert(msg.messageType === "text", "Message type mismatch");

  const profile = new Profile({
    id: "prof-123",
    companyId: "comp-1",
    name: "John Doe",
    metadata: { tier: "VIP" },
  });

  assert(profile.id === "prof-123", "Profile ID mismatch");
  assert(profile.companyId === "comp-1", "Profile company ID mismatch");
  assert(profile.metadata.tier === "VIP", "Profile metadata mismatch");
  console.log("✔ Test 1 Passed.\n");

  // 2. Conversation Aggregate State Mutations & Events
  console.log("Running Test 2: Conversation Aggregate & Takeover events...");
  const conv = new Conversation({
    id: "99",
    projectId: "1",
    identityId: "12",
    status: "open",
    handledBy: "ai",
  });

  assert(conv.status === "open", "Initial status must be open");
  assert(conv.handledBy === "ai", "Initial handler must be AI");

  // A. Initiate takeover
  console.log("Initiating operator takeover...");
  conv.initiateTakeover("agent-55", 15 * 60 * 1000); // 15 minutes lease
  assert(conv.handledBy === "human", "Handler must change to human");
  assert(conv.assignedPm === "agent-55", "Assigned PM mismatch");
  assert(conv.takeoverExpiresAt !== null, "Takeover expiration must be set");

  // Verify TakeoverStartedEvent is registered
  let events = conv.domainEvents;
  assert(events.length === 1, "Should have tracked 1 event");
  assert(events[0] instanceof TakeoverStartedEvent, "Event type mismatch");
  assert((events[0] as TakeoverStartedEvent).agentId === "agent-55", "Event agent ID mismatch");

  // B. Release takeover
  console.log("Releasing operator takeover...");
  conv.releaseTakeover();
  assert(conv.handledBy === "ai", "Handler must revert to AI");
  assert(conv.assignedPm === undefined, "Assigned PM must be cleared");
  assert(conv.takeoverExpiresAt === null, "Expiration must be cleared");

  events = conv.domainEvents;
  assert(events.length === 2, "Should have tracked 2 events");
  assert(events[1] instanceof TakeoverEndedEvent, "Event type mismatch");

  // C. Close session
  console.log("Closing conversation session...");
  conv.close();
  assert(conv.status === "closed", "Conversation status must be closed");

  events = conv.domainEvents;
  // conv.close() internally releases takeover (triggering TakeoverEnded) and closes (triggering ConversationClosed)
  // Let's check how many events are accumulated
  assert(events.length === 4, "Should have tracked 4 events total");
  assert(events[3] instanceof ConversationClosedEvent, "Final event mismatch");
  console.log("✔ Test 2 Passed.\n");

  console.log("============================================================");
  console.log("              All AX-BE-037 Tests Passed!                   ");
  console.log("============================================================");
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Test Suite Failed:");
    console.error(err);
    process.exit(1);
  });
