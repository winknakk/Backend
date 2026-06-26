import Redis from "ioredis";
import { randomUUID } from "crypto";
import { IJobQueue, JobPayload } from "./types";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";
import { runWithContext } from "../observability/tracer";

const logger = createLogger("RedisJobQueue");

export class RedisJobQueue implements IJobQueue {
  private redisClient: Redis;
  private handler: ((job: JobPayload) => Promise<any>) | null = null;
  private running = true;
  private activeWorkers = 0;

  constructor() {
    logger.info(`Connecting to Redis for Job Queue at: ${config.REDIS_URL}`);
    this.redisClient = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });
    this.redisClient.on("error", (err) => {
      logger.error({ error: err.message }, "Job queue Redis client connection error");
    });

    // Start background polling worker
    this.startWorker();
  }

  async enqueue(
    payload: Omit<JobPayload, "jobId" | "status" | "retryCount" | "maxRetry"> & { retryCount?: number; maxRetry?: number }
  ): Promise<string> {
    const jobId = randomUUID();
    const job: JobPayload = {
      ...payload,
      retryCount: payload.retryCount ?? 0,
      maxRetry: payload.maxRetry ?? 3,
      jobId,
      status: "QUEUED",
    };

    // Store job details in Redis (expires in 24 hours)
    await this.redisClient.setex(`job:${jobId}`, 86400, JSON.stringify(job));
    // Push jobId to list
    await this.redisClient.lpush("queue:jobs", jobId);

    logger.info({ jobId, type: job.type, requestId: job.metadata.requestId }, "Job enqueued in Redis");

    return jobId;
  }

  process(handler: (job: JobPayload) => Promise<any>): void {
    this.handler = handler;
    logger.info("Redis Job queue handler registered");
  }

  async getJob(jobId: string): Promise<JobPayload | null> {
    const raw = await this.redisClient.get(`job:${jobId}`);
    return raw ? (JSON.parse(raw) as JobPayload) : null;
  }

  private startWorker(): void {
    // Run worker loop in background
    (async () => {
      while (this.running) {
        try {
          if (!this.handler) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }

          const jobId = await this.redisClient.rpop("queue:jobs");
          if (!jobId) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            continue;
          }

          this.activeWorkers++;
          await this.processJob(jobId);
          this.activeWorkers--;
        } catch (err: any) {
          logger.error({ error: err.message }, "Error in Redis queue worker loop");
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    })();
  }

  private async processJob(jobId: string): Promise<void> {
    const job = await this.getJob(jobId);
    if (!job || !this.handler) return;

    // Propagate distributed traceId and requestId context using AsyncLocalStorage
    const traceContext = {
      traceId: job.metadata.requestId || randomUUID(), // fallback if missing
      requestId: job.metadata.requestId,
      conversationId: job.data?.conversationId || undefined,
    };

    await runWithContext(traceContext, async () => {
      // Transition to RUNNING
      job.status = "RUNNING";
      job.startedAt = new Date().toISOString();
      await this.redisClient.setex(`job:${jobId}`, 86400, JSON.stringify(job));
      logger.info({ jobId, type: job.type }, "Job started");

      try {
        const result = await this.handler!(job);

        // Transition to COMPLETED
        job.status = "COMPLETED";
        job.result = result;
        job.completedAt = new Date().toISOString();
        await this.redisClient.setex(`job:${jobId}`, 86400, JSON.stringify(job));
        logger.info({ jobId, type: job.type }, "Job completed successfully");
      } catch (err: any) {
        logger.error({ jobId, type: job.type, error: err.message }, "Job failed during execution");

        if (job.retryCount < job.maxRetry) {
          job.retryCount++;
          job.status = "QUEUED";
          job.error = err.message || String(err);
          await this.redisClient.setex(`job:${jobId}`, 86400, JSON.stringify(job));

          // Jittered exponential retry backoff: base 100ms * 2^retry + random jitter
          const baseDelay = 100;
          const delay = baseDelay * Math.pow(2, job.retryCount);
          const jitter = Math.random() * (delay * 0.5);
          const finalDelay = delay + jitter;

          logger.warn({ jobId, retryCount: job.retryCount, delayMs: finalDelay }, "Scheduling job retry");

          setTimeout(async () => {
            try {
              await this.redisClient.lpush("queue:jobs", jobId);
            } catch (err: any) {
              logger.error({ jobId, error: err.message }, "Failed to requeue job for retry");
            }
          }, finalDelay);
        } else {
          // Transition to FAILED (exhausted retries)
          job.status = "FAILED";
          job.error = err.message || String(err);
          job.completedAt = new Date().toISOString();
          await this.redisClient.setex(`job:${jobId}`, 86400, JSON.stringify(job));
          logger.error(
            { jobId, type: job.type, error: job.error },
            "Job execution failed completely (retries exhausted)"
          );
        }
      }
    });
  }

  async getQueueDepth(): Promise<number> {
    try {
      return await this.redisClient.llen("queue:jobs");
    } catch {
      return 0;
    }
  }

  getActiveWorkersCount(): number {
    return this.activeWorkers;
  }

  async disconnect(): Promise<void> {
    this.running = false;
    try {
      await this.redisClient.quit();
      logger.info("Job queue Redis connection closed cleanly.");
    } catch (err: any) {
      logger.warn({ error: err.message }, "Error during Redis job queue disconnect");
    }
  }
}
