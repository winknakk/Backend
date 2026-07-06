import { Queue } from "bullmq";
import Redis from "ioredis";
import { config } from "../../config/env";
import { createLogger } from "../../observability/logger";
import { IJobQueue, JobPayload, JobStatus } from "../../queue/types";
import { ProcessIncomingMessageWorker } from "../../application/jobs/ProcessIncomingMessageWorker";

const logger = createLogger("BullMQJobQueue");

export class BullMQJobQueue implements IJobQueue {
  private queue: Queue;
  private redisConnection: Redis;
  private worker: ProcessIncomingMessageWorker | null = null;

  constructor() {
    this.redisConnection = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null, // Required by BullMQ
      enableOfflineQueue: true,
    });

    this.queue = new Queue("message-queue", {
      connection: this.redisConnection as any,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });

    this.redisConnection.on("error", (err) => {
      logger.error({ error: err.message }, "BullMQJobQueue Redis connection error");
    });
  }

  /**
   * Enqueues a message payload to BullMQ.
   */
  async enqueue(
    payload: Omit<JobPayload, "jobId" | "status" | "retryCount" | "maxRetry"> & { retryCount?: number; maxRetry?: number }
  ): Promise<string> {
    const jobId = payload.metadata?.requestId || require("crypto").randomUUID();
    logger.info({ jobId, type: payload.type }, "Enqueueing message job to BullMQ queue");
    
    await this.queue.add("incoming-message", payload, {
      jobId,
    });

    return jobId;
  }

  /**
   * Registers the worker to handle queued jobs.
   */
  process(handler: (job: JobPayload) => Promise<any>): void {
    if (this.worker) {
      logger.warn("Worker already registered for BullMQJobQueue, ignoring second registration");
      return;
    }
    logger.info("Initializing BullMQ ProcessIncomingMessageWorker thread");
    this.worker = new ProcessIncomingMessageWorker(handler);
  }

  /**
   * Retrieves the current state/payload of a job from BullMQ.
   */
  async getJob(jobId: string): Promise<JobPayload | null> {
    const job = await this.queue.getJob(jobId);
    if (!job) return null;

    const state = await job.getState();
    let status: JobStatus = "QUEUED";
    if (state === "active") {
      status = "RUNNING";
    } else if (state === "completed") {
      status = "COMPLETED";
    } else if (state === "failed") {
      status = "FAILED";
    }

    return {
      jobId: job.id!,
      type: job.data.type,
      data: job.data.data,
      metadata: job.data.metadata,
      status,
      retryCount: job.attemptsMade,
      maxRetry: job.opts.attempts || 3,
      result: job.returnvalue,
      error: job.failedReason,
    };
  }

  /**
   * Retrieves the current queue depth (waiting, active, and delayed job counts).
   */
  async getQueueDepth(): Promise<number> {
    const counts = await this.queue.getJobCounts("wait", "active", "delayed");
    return (counts.wait || 0) + (counts.active || 0) + (counts.delayed || 0);
  }

  /**
   * Closes the queue and any active worker connections.
   */
  async disconnect(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
    await this.queue.close();
    await this.redisConnection.quit();
  }
}
export default BullMQJobQueue;
