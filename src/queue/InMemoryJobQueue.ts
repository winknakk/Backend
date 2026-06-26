import { randomUUID } from "crypto";
import { IJobQueue, JobPayload } from "./types";
import { createLogger } from "../observability/logger";
import { runWithContext } from "../observability/tracer";

const logger = createLogger("InMemoryJobQueue");

/**
 * Synchronous in-process implementation of IJobQueue for local testing.
 * Jobs are stored in memory and processed immediately.
 */
export class InMemoryJobQueue implements IJobQueue {
  private jobs = new Map<string, JobPayload>();
  private handler: ((job: JobPayload) => Promise<any>) | null = null;
  private activeWorkers = 0;

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

    this.jobs.set(jobId, job);
    logger.info({ jobId, type: job.type, requestId: job.metadata.requestId }, "Job enqueued in-memory");

    // If a handler is registered, process immediately
    if (this.handler) {
      this.activeWorkers++;
      await this.processJob(job);
      this.activeWorkers--;
    }

    return jobId;
  }

  process(handler: (job: JobPayload) => Promise<any>): void {
    this.handler = handler;
    logger.info("In-memory Job handler registered");
  }

  async getJob(jobId: string): Promise<JobPayload | null> {
    return this.jobs.get(jobId) || null;
  }

  private async processJob(job: JobPayload): Promise<void> {
    if (!this.handler) {
      logger.warn({ jobId: job.jobId }, "No handler registered, skipping job");
      return;
    }

    // Set context trace context
    const traceContext = {
      traceId: job.metadata.requestId || randomUUID(),
      requestId: job.metadata.requestId,
      conversationId: job.data?.conversationId || undefined,
    };

    await runWithContext(traceContext, async () => {
      // Transition to RUNNING
      job.status = "RUNNING";
      job.startedAt = new Date().toISOString();
      this.jobs.set(job.jobId, job);
      logger.info({ jobId: job.jobId, type: job.type }, "Job started");

      try {
        const result = await this.handler!(job);

        // Transition to COMPLETED
        job.status = "COMPLETED";
        job.result = result;
        job.completedAt = new Date().toISOString();
        this.jobs.set(job.jobId, job);
        logger.info({ jobId: job.jobId, type: job.type }, "Job completed successfully");
      } catch (err: any) {
        logger.error({ jobId: job.jobId, type: job.type, error: err.message }, "Job failed");

        if (job.retryCount < job.maxRetry) {
          job.retryCount++;
          logger.warn({ jobId: job.jobId, retryCount: job.retryCount }, "Retrying in-memory job synchronously");
          await this.processJob(job);
        } else {
          // Transition to FAILED
          job.status = "FAILED";
          job.error = err.message || String(err);
          job.completedAt = new Date().toISOString();
          this.jobs.set(job.jobId, job);
          logger.error({ jobId: job.jobId, type: job.type, error: job.error }, "Job failed completely");
        }
      }
    });
  }

  getQueueDepth(): number {
    return Array.from(this.jobs.values()).filter((j) => j.status === "QUEUED").length;
  }

  getActiveWorkersCount(): number {
    return this.activeWorkers;
  }

  async disconnect(): Promise<void> {
    logger.info("In-memory job queue shutdown cleanly.");
  }
}
