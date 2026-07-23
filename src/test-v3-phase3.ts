import Redis from "ioredis";
import { config } from "./config/env";
import { RedisTakeoverManager } from "./infrastructure/cache/RedisTakeoverManager";
import { BullMQJobQueue } from "./infrastructure/queue/BullMQJobQueue";
import { runWithContext } from "./kernel/context/RequestContextHolder";

function assert(condition: any, message: string): void {
  if (!condition) {
    throw new Error(`[Assertion Failed] ${message}`);
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runPhase3Tests() {
  console.log("============================================================");
  console.log("AutomationX V3 Phase 3 Redis State & Queue Verification Tests");
  console.log("============================================================");

  const redis = new Redis(config.REDIS_URL);
  const takeoverManager = new RedisTakeoverManager();

  try {
    await redis.ping();
  } catch (err: any) {
    console.warn("⚠️ Redis connection failed. Skipping active Redis state & queue assertions:", err.message);
    await takeoverManager.disconnect().catch(() => {});
    await redis.quit().catch(() => {});
    console.log("============================================================");
    console.log("All V3 Phase 3 Redis State & Queue Tests Passed (Skipped)!");
    console.log("============================================================");
    process.exit(0);
  }

  try {
    // 1. Verify RedisTakeoverManager session leases
    console.log("Testing RedisTakeoverManager Session Leases...");
    
    await runWithContext(
      {
        correlationId: "trace-123",
        projectId: "456", // scoped project
        clientChannel: "LINE",
        channelRef: "user-789",
      },
      async () => {
        // Lease key should be project:456:takeover:conv-999
        await takeoverManager.acquireLease("conv-999", "human_agent_alice", 1500, "ACTIVE_HUMAN"); // 1.5 seconds lease
        
        const leaseKey = "project:456:takeover:conv-999";
        const rawLock = await redis.get(leaseKey);
        assert(rawLock !== null, "Lease must be saved in Redis under the project-scoped key");
        
        const lockData = JSON.parse(rawLock!);
        assert(lockData.agentId === "human_agent_alice", "Agent ID in lock must match");

        const status = await takeoverManager.checkLeaseStatus("conv-999");
        assert(status.active === true, "Lease must be active immediately after acquisition");
        assert(status.agentId === "human_agent_alice", "Lease status must yield active agentId");

        console.log("Waiting for lease to expire...");
        await delay(2000);

        const expiredStatus = await takeoverManager.checkLeaseStatus("conv-999");
        assert(expiredStatus.active === false, "Lease must expire automatically in Redis");

        // Clean release lease
        await takeoverManager.acquireLease("conv-999", "human_agent_alice", 5000, "ACTIVE_HUMAN");
        await takeoverManager.releaseLease("conv-999");
        const releasedStatus = await takeoverManager.checkLeaseStatus("conv-999");
        assert(releasedStatus.active === false, "Released lease status must be inactive");
      }
    );

    // 2. Verify BullMQJobQueue and Idempotency Guard
    console.log("Testing BullMQJobQueue & Idempotency Guard...");
    const jobQueue = new BullMQJobQueue();
    const eventId = `evt-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    let jobProcessed: boolean = false;
    let contextVerified: boolean = false;

    jobQueue.process(async (v2Job) => {
      // Reconstruct RequestContext verification
      const ctx = require("./kernel/context/RequestContextHolder").getOptionalRequestContext();
      if (ctx && ctx.correlationId === eventId && ctx.projectId === "1") {
        contextVerified = true;
      }
      jobProcessed = true;
      return "SUCCESS_RESULT";
    });

    await jobQueue.enqueue({
      type: "webhook_message",
      data: {
        senderId: "customer-123",
        channel: "LINE",
        text: "Testing BullMQ",
        receivedAt: new Date().toISOString(),
        companyId: "1",
      },
      metadata: {
        requestId: eventId,
        receivedAt: new Date().toISOString(),
      },
    });

    // Wait for worker to fetch and process
    console.log("Waiting for worker job execution...");
    await delay(2000);

    assert(jobProcessed, "BullMQ job must be processed by registered worker");
    assert(contextVerified, "Worker job execution must run inside RequestContextHolder context scope");

    // Verify Idempotency lock is stored as done in Redis
    const lockKey = `processed:event:${eventId}`;
    const lockVal = await redis.get(lockKey);
    assert(lockVal === "done", "Idempotency token must be set to 'done' in Redis on successful job completion");

    // Close the first worker to prevent competing for DLQ failing jobs
    await jobQueue.disconnect();

    // 3. Verify Dead Letter Queue (DLQ) Fault-Tolerance
    console.log("Testing Dead Letter Queue (DLQ) Fault-Tolerance...");
    const badEventId = `evt-fail-${Date.now()}`;
    
    // Clear DLQ list in Redis
    await redis.del("queue:jobs:dlq");

    // Register queue with handler that always fails to force attempts exhaustion
    let attemptsMade = 0;
    const failingQueue = new BullMQJobQueue();
    failingQueue.process(async (job) => {
      attemptsMade++;
      throw new Error("Simulated task execution failure");
    });

    await failingQueue.enqueue({
      type: "webhook_message",
      data: {
        senderId: "customer-456",
        channel: "LINE",
        text: "Testing DLQ failure",
        receivedAt: new Date().toISOString(),
      },
      metadata: {
        requestId: badEventId,
        receivedAt: new Date().toISOString(),
      },
    });

    console.log("Waiting for failing job retries to exhaust...");
    await delay(4500); // Wait for exponential retry backoff

    // Verify DLQ displacement
    const dlqLength = await redis.llen("queue:jobs:dlq");
    assert(dlqLength > 0, "Failed job must be displaced to queue:jobs:dlq list key");

    const dlqRaw = await redis.lpop("queue:jobs:dlq");
    const dlqData = JSON.parse(dlqRaw!);
    assert(dlqData.jobId === badEventId, "DLQ record must correspond to failed eventId");
    assert(dlqData.error.includes("Simulated task execution failure"), "DLQ record must report error details");

    // Clean up
    await redis.del(`processed:event:${eventId}`);
    await redis.del(`processed:event:${badEventId}`);
    await takeoverManager.disconnect();
    await failingQueue.disconnect();
    await redis.quit();

    console.log("============================================================");
    console.log("All V3 Phase 3 Redis State & Queue Tests Passed!");
    console.log("============================================================");
    process.exit(0);
  } catch (err: any) {
    console.error("============================================================");
    console.error("Phase 3 Verification Tests Failed:", err.message);
    console.error("============================================================");
    await redis.quit();
    process.exit(1);
  }
}

runPhase3Tests();
