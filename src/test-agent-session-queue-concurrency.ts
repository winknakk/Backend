import pg from "pg";
import { config } from "./config/env";
import { AgentSessionQueueService } from "./services/AgentSessionQueueService";
import { AgentSessionQueueWorker } from "./services/AgentSessionQueueWorker";

function assert(condition: any, message: string): void {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 10000,
});

async function setupTestEnvironment(): Promise<void> {
  // Ensure tables and test conversation exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_session_queue (
      id BIGSERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      source_event_id VARCHAR(255),
      channel VARCHAR(50) NOT NULL DEFAULT 'line',
      sender_ref VARCHAR(255) NOT NULL,
      destination VARCHAR(255),
      project_id INTEGER,
      payload JSONB NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'queued',
      lease_token VARCHAR(100),
      lease_expires_at TIMESTAMPTZ,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      error_detail TEXT,
      sequence_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_session_queue_conv_event 
      ON agent_session_queue(conversation_id, source_event_id) 
      WHERE source_event_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_agent_session_queue_conv_status 
      ON agent_session_queue(conversation_id, status, sequence_at);

    CREATE INDEX IF NOT EXISTS idx_agent_session_queue_leases 
      ON agent_session_queue(status, lease_expires_at);

    CREATE TABLE IF NOT EXISTS agent_session_state (
      conversation_id INTEGER PRIMARY KEY,
      active_queue_item_id BIGINT,
      lease_token VARCHAR(100),
      lease_expires_at TIMESTAMPTZ,
      last_active_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Clean up any test data from previous runs
  await pool.query(`
    DELETE FROM agent_session_queue WHERE conversation_id IN (99901, 99902, 99903, 99904, 99905);
    DELETE FROM agent_session_state WHERE conversation_id IN (99901, 99902, 99903, 99904, 99905);
    DELETE FROM conversations WHERE id IN (99901, 99902, 99903, 99904, 99905);
  `);

  // Seed test profile, identity, and test conversations for FK satisfaction
  await pool.query(`
    INSERT INTO profiles (id, name) 
    VALUES ('prof_test_queue', 'Queue Test Profile') 
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO identities (id, profile_id, channel, channel_ref) 
    VALUES (99901, 'prof_test_queue', 'line', 'line_test_queue_ref') 
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO conversations (id, identity_id, project_id, channel, status) 
    VALUES
      (99901, '99901', 1, 'line', 'open'),
      (99902, '99901', 1, 'line', 'open'),
      (99903, '99901', 1, 'line', 'open'),
      (99904, '99901', 1, 'line', 'open'),
      (99905, '99901', 1, 'line', 'open')
    ON CONFLICT (id) DO NOTHING;
  `);
}

async function cleanupTestEnvironment(): Promise<void> {
  await pool.query(`
    DELETE FROM agent_session_queue WHERE conversation_id IN (99901, 99902, 99903, 99904, 99905);
    DELETE FROM agent_session_state WHERE conversation_id IN (99901, 99902, 99903, 99904, 99905);
    DELETE FROM conversations WHERE id IN (99901, 99902, 99903, 99904, 99905);
    DELETE FROM identities WHERE id = 99901;
    DELETE FROM profiles WHERE id = 'prof_test_queue';
  `);
  await pool.end();
}

async function runAllTests(): Promise<void> {
  console.log("=================================================================");
  console.log("  Agent Session Queue & Atomic Lease Concurrency Test Suite");
  console.log("=================================================================\n");

  await setupTestEnvironment();
  const queueService = new AgentSessionQueueService(pool);

  // -------------------------------------------------------------
  // Test 1: Deduplication & Idempotency
  // -------------------------------------------------------------
  console.log("👉 Test 1: Deduplication & Idempotency");
  const testConv1 = 99901;
  const duplicateSourceEventId = "line-msg-dup-1001";

  const enqueueResults = await Promise.all([
    queueService.enqueue({
      conversationId: testConv1,
      sourceEventId: duplicateSourceEventId,
      channel: "line",
      senderRef: "user_test_1",
      destination: "dest_1",
      projectId: 1,
      payload: { text: "Duplicate test 1" },
    }),
    queueService.enqueue({
      conversationId: testConv1,
      sourceEventId: duplicateSourceEventId,
      channel: "line",
      senderRef: "user_test_1",
      destination: "dest_1",
      projectId: 1,
      payload: { text: "Duplicate test 2" },
    }),
    queueService.enqueue({
      conversationId: testConv1,
      sourceEventId: duplicateSourceEventId,
      channel: "line",
      senderRef: "user_test_1",
      destination: "dest_1",
      projectId: 1,
      payload: { text: "Duplicate test 3" },
    }),
  ]);

  const enqueuedCount = enqueueResults.filter((r) => r.enqueued).length;
  const duplicateCount = enqueueResults.filter((r) => r.isDuplicate).length;

  assert(enqueuedCount === 1, `Expected exactly 1 enqueued result, got ${enqueuedCount}`);
  assert(duplicateCount === 2, `Expected exactly 2 duplicate results, got ${duplicateCount}`);

  const countInDbRes = await pool.query(
    `SELECT COUNT(*)::integer AS count FROM agent_session_queue WHERE conversation_id = $1 AND source_event_id = $2`,
    [testConv1, duplicateSourceEventId]
  );
  assert(Number(countInDbRes.rows[0].count) === 1, "Expected exactly 1 row in DB for duplicate event ID");
  console.log("   ✅ Passed: 3 concurrent duplicate webhooks produced exactly 1 database queue item.\n");

  // -------------------------------------------------------------
  // Test 2: Strict Serialization per Conversation (Atomic Lease)
  // -------------------------------------------------------------
  console.log("👉 Test 2: Strict Serialization & Lease Concurrency Control");
  const testConv2 = 99902;

  // Enqueue 3 sequential messages
  const msg1 = await queueService.enqueue({
    conversationId: testConv2,
    sourceEventId: "line-seq-001",
    senderRef: "user_test_2",
    payload: { text: "Message 1" },
    sequenceAt: new Date(Date.now() - 3000),
  });

  const msg2 = await queueService.enqueue({
    conversationId: testConv2,
    sourceEventId: "line-seq-002",
    senderRef: "user_test_2",
    payload: { text: "Message 2" },
    sequenceAt: new Date(Date.now() - 2000),
  });

  const msg3 = await queueService.enqueue({
    conversationId: testConv2,
    sourceEventId: "line-seq-003",
    senderRef: "user_test_2",
    payload: { text: "Message 3" },
    sequenceAt: new Date(Date.now() - 1000),
  });

  // The first two dispatches may race while agent_session_state does not yet
  // have a row. Exactly one of them must create/lock that row and claim turn 1.
  const initialClaims = await Promise.all([
    queueService.claimNext(testConv2, 60000),
    queueService.claimNext(testConv2, 60000),
  ]);
  const claimedInitially = initialClaims.filter((claim) => claim !== null);
  assert(claimedInitially.length === 1, "Turn 1: Two first-time dispatches must produce exactly one lease claim");

  // Turn 1: Claim first message
  const claim1 = claimedInitially[0];
  assert(claim1 !== null, "Turn 1: Expected claimNext to return a valid item");
  assert(claim1!.id === msg1.item.id, `Turn 1: Expected msg1 (${msg1.item.id}) to be claimed first, got ${claim1!.id}`);
  assert(claim1!.status === "processing", "Turn 1: Item status should be processing");
  assert(typeof claim1!.lease_token === "string" && claim1!.lease_token.length > 0, "Turn 1: Expected valid lease token");

  // While Turn 1 is active: Attempt concurrent claim -> MUST return null (Busy)
  const concurrentClaim = await queueService.claimNext(testConv2, 60000);
  assert(concurrentClaim === null, "Turn 1: Concurrent claim attempt while lease is active MUST return null");

  // Turn 1 completes: Complete Turn 1 and atomically claim Turn 2
  const claim2 = await queueService.completeAndClaimNext(testConv2, claim1!.id, claim1!.lease_token!, 60000);
  assert(claim2 !== null, "Turn 2: completeAndClaimNext should return next queued message");
  assert(claim2!.id === msg2.item.id, `Turn 2: Expected msg2 (${msg2.item.id}) to be claimed, got ${claim2!.id}`);

  // Check that Turn 1 is marked completed in DB
  const turn1DbRes = await pool.query(`SELECT status, completed_at FROM agent_session_queue WHERE id = $1`, [claim1!.id]);
  assert(turn1DbRes.rows[0].status === "completed", "Turn 1 in DB should be completed");
  assert(turn1DbRes.rows[0].completed_at !== null, "Turn 1 completed_at should not be null");

  // Turn 2 completes: Complete Turn 2 and atomically claim Turn 3
  const claim3 = await queueService.completeAndClaimNext(testConv2, claim2!.id, claim2!.lease_token!, 60000);
  assert(claim3 !== null, "Turn 3: completeAndClaimNext should return next queued message");
  assert(claim3!.id === msg3.item.id, `Turn 3: Expected msg3 (${msg3.item.id}) to be claimed, got ${claim3!.id}`);

  // Turn 3 completes: Queue is now empty
  const claim4 = await queueService.completeAndClaimNext(testConv2, claim3!.id, claim3!.lease_token!, 60000);
  assert(claim4 === null, "Turn 4: When queue is drained, completeAndClaimNext should return null");

  // Verify conversation session state is completely cleared
  const stateRes = await pool.query(`SELECT * FROM agent_session_state WHERE conversation_id = $1`, [testConv2]);
  assert(stateRes.rows[0].active_queue_item_id === null, "State active_queue_item_id should be null when queue drained");
  assert(stateRes.rows[0].lease_token === null, "State lease_token should be null when queue drained");

  console.log("   ✅ Passed: 3 sequential messages executed in strict 1-by-1 order with zero interleaved turns.\n");

  // -------------------------------------------------------------
  // Test 3: Parallel Cross-Conversation Isolation
  // -------------------------------------------------------------
  console.log("👉 Test 3: Parallel Cross-Conversation Isolation");
  const convA = 99903;
  const convB = 99904;

  await queueService.enqueue({
    conversationId: convA,
    sourceEventId: "conv-a-msg-1",
    senderRef: "user_a",
    payload: { text: "Hello from A" },
  });

  await queueService.enqueue({
    conversationId: convB,
    sourceEventId: "conv-b-msg-1",
    senderRef: "user_b",
    payload: { text: "Hello from B" },
  });

  const [claimA, claimB] = await Promise.all([
    queueService.claimNext(convA, 60000),
    queueService.claimNext(convB, 60000),
  ]);

  assert(claimA !== null, "Conversation A should successfully claim its lease");
  assert(claimB !== null, "Conversation B should successfully claim its lease concurrently");
  assert(claimA!.conversation_id === convA, "Claim A belongs to Conversation A");
  assert(claimB!.conversation_id === convB, "Claim B belongs to Conversation B");
  assert(claimA!.lease_token !== claimB!.lease_token, "Different conversations must have distinct lease tokens");

  // Clean up
  await queueService.completeAndClaimNext(convA, claimA!.id, claimA!.lease_token!);
  await queueService.completeAndClaimNext(convB, claimB!.id, claimB!.lease_token!);
  console.log("   ✅ Passed: Independent conversations run in parallel without cross-blocking.\n");

  // -------------------------------------------------------------
  // Test 4: Lease Expiration & Auto-Recovery
  // -------------------------------------------------------------
  console.log("👉 Test 4: Lease Expiration & Auto-Recovery");
  const testConv4 = 99905;

  const expireItem = await queueService.enqueue({
    conversationId: testConv4,
    sourceEventId: "expire-test-001",
    senderRef: "user_expire",
    payload: { text: "Crash recovery test" },
  });

  // Claim with past lease (-1000ms) to simulate expired worker lease
  const shortClaim = await queueService.claimNext(testConv4, -1000);
  assert(shortClaim !== null, "Item should be claimed");

  // Run watchdog recovery
  const recoveryResult = await queueService.recoverExpiredLeases(2);
  assert(recoveryResult.recoveredCount >= 1, "Expected at least 1 expired lease recovered");

  // Item should now be re-queued and claimable again
  const recoveredClaim = await queueService.claimNext(testConv4, 60000);
  assert(recoveredClaim !== null, "Recovered item should be claimable again");
  assert(recoveredClaim!.id === expireItem.item.id, "Claimed item ID matches");
  assert(recoveredClaim!.attempt_count === 2, `Expected attempt_count = 2, got ${recoveredClaim!.attempt_count}`);

  // Complete recovered item
  await queueService.completeAndClaimNext(testConv4, recoveredClaim!.id, recoveredClaim!.lease_token!);
  console.log("   ✅ Passed: Expired lease recovered automatically and successfully re-executed.\n");

  // -------------------------------------------------------------
  // Test 5: Observability & Metrics
  // -------------------------------------------------------------
  console.log("👉 Test 5: Observability & Metrics Aggregation");
  const metrics = await queueService.getQueueStatus();
  assert(typeof metrics.queued === "number", "metrics.queued is number");
  assert(typeof metrics.processing === "number", "metrics.processing is number");
  assert(typeof metrics.completed === "number", "metrics.completed is number");
  assert(typeof metrics.activeConversationsWithLeases === "number", "activeConversations is number");
  assert(metrics.completed >= 5, `Expected at least 5 completed items in test run, got ${metrics.completed}`);
  console.log(`   Status Summary: queued=${metrics.queued}, processing=${metrics.processing}, completed=${metrics.completed}, activeLeases=${metrics.activeConversationsWithLeases}`);
  console.log("   ✅ Passed: Observability status aggregates correctly.\n");

  console.log("=================================================================");
  console.log("  🎉 ALL 5 CONCURRENCY & LEASE TESTS PASSED CLEANLY!");
  console.log("=================================================================\n");
}

runAllTests()
  .catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await cleanupTestEnvironment();
  });
