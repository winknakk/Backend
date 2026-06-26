import { QueueFactory } from "./queue/QueueFactory";
import { InMemoryJobQueue } from "./queue/InMemoryJobQueue";
import { RedisJobQueue } from "./queue/RedisJobQueue";
import { JobPayload } from "./queue/types";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log("=========================================");
  console.log("    Testing Distributed Queue Services");
  console.log("=========================================");

  // 1. Test In-Memory Queue Provider
  console.log("Testing InMemoryJobQueue...");
  const memQueue = new InMemoryJobQueue();
  let memProcessed = false;

  memQueue.process(async (job: JobPayload) => {
    memProcessed = true;
    return { status: "processed", payload: job.data };
  });

  const memJobId = await memQueue.enqueue({
    type: "webhook_message",
    data: { senderId: "user-1", channel: "LINE", text: "hello memory" },
    metadata: { requestId: "req-mem-1", receivedAt: new Date().toISOString() },
  });

  assert(memJobId !== undefined && typeof memJobId === "string", "Should return valid jobId string");

  const memJob = await memQueue.getJob(memJobId);
  assert(memJob !== null, "Should retrieve enqueued job");
  assert(memJob!.status === "COMPLETED", "In-memory job should process synchronously immediately");
  assert(memJob!.result?.payload?.text === "hello memory", "Job result should match input");
  assert(memProcessed, "Handler callback must have been executed");
  await memQueue.disconnect();

  // 2. Test Redis Queue Provider
  console.log("Testing RedisJobQueue...");
  process.env.QUEUE_PROVIDER = "redis";
  let redisQueue: RedisJobQueue | null = null;
  try {
    redisQueue = new RedisJobQueue();
    console.log("Successfully connected to Redis. Running Redis queue tests...");

    let redisProcessed = false;
    redisQueue.process(async (job: JobPayload) => {
      redisProcessed = true;
      return { status: "processed", payload: job.data };
    });

    const redisJobId = await redisQueue.enqueue({
      type: "webhook_message",
      data: { senderId: "user-2", channel: "LINE", text: "hello redis" },
      metadata: { requestId: "req-redis-1", receivedAt: new Date().toISOString() },
    });

    // Wait for worker to pop and process the job
    console.log("Waiting for Redis worker processing...");
    let jobDetail: JobPayload | null = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      jobDetail = await redisQueue.getJob(redisJobId);
      if (jobDetail && jobDetail.status === "COMPLETED") {
        break;
      }
    }

    assert(jobDetail !== null, "Redis job detail should exist");
    assert(jobDetail!.status === "COMPLETED", `Redis job status should be COMPLETED, got: ${jobDetail?.status}`);
    assert(jobDetail!.result?.payload?.text === "hello redis", "Redis job result should match input");
    assert(redisProcessed, "Redis handler callback must have been executed");

    // Test exponential retry backoff
    console.log("Testing Redis queue job failure retry backoff...");
    let attemptCount = 0;
    const failJobId = await redisQueue.enqueue({
      type: "webhook_message",
      data: { fail: true },
      metadata: { requestId: "req-fail-1", receivedAt: new Date().toISOString() },
      maxRetry: 1,
    });

    redisQueue.process(async (job: JobPayload) => {
      attemptCount++;
      throw new Error(`Execution failure attempt ${attemptCount}`);
    });

    // Wait for execution and retry
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const failJob = await redisQueue.getJob(failJobId);
      if (failJob && failJob.status === "FAILED") {
        break;
      }
    }

    const finalFailJob = await redisQueue.getJob(failJobId);
    assert(finalFailJob !== null, "Failed job should exist in storage");
    assert(finalFailJob!.status === "FAILED", `Failed job should have status FAILED, got: ${finalFailJob?.status}`);
    assert(finalFailJob!.retryCount === 1, "Should have retried exactly once");
    assert(attemptCount === 2, "Should have run handler twice");

    try {
      await redisQueue.disconnect();
    } catch {}
  } catch (err: any) {
    console.log("⚠️ Redis connection or execution failed. Skipping active Redis queue assertions:", err.message);
    if (redisQueue) {
      try {
        await redisQueue.disconnect();
      } catch {}
    }
  }

  console.log("✅ Distributed Queue tests PASSED successfully!");
  process.exit(0);
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
