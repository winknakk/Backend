import { randomUUID } from "crypto";
import { IJobQueue, JobPayload } from "./types";
import { createLogger } from "../observability/logger";

const logger = createLogger("SyncJobQueue");

/**
 * Synchronous in-process implementation of IJobQueue.
 * Jobs are stored in memory and processed immediately when a handler is registered.
 */
export class SyncJobQueue implements IJobQueue {
  private jobs = new Map<string, JobPayload>();
  private handler: ((job: JobPayload) => Promise<any>) | null = null;

  async enqueue(
    payload: Omit<JobPayload, "jobId" | "status">
  ): Promise<string> {
    const jobId = randomUUID();
    const job: JobPayload = {
      retryCount: 0,
      maxRetry: 3,
      ...payload,
      jobId,
      status: "QUEUED",
    };

    this.jobs.set(jobId, job);
    logger.info(
      { jobId, type: job.type, requestId: job.metadata.requestId },
      "Job enqueued"
    );

    // If a handler is registered, process immediately
    if (this.handler) {
      await this.processJob(job);
    }

    return jobId;
  }

  process(handler: (job: JobPayload) => Promise<any>): void {
    this.handler = handler;
    logger.info("Job handler registered");
  }

  async getJob(jobId: string): Promise<JobPayload | null> {
    return this.jobs.get(jobId) || null;
  }

  private async processJob(job: JobPayload): Promise<void> {
    if (!this.handler) {
      logger.warn({ jobId: job.jobId }, "No handler registered, skipping job");
      return;
    }

    // Transition to RUNNING
    job.status = "RUNNING";
    job.startedAt = new Date().toISOString();
    this.jobs.set(job.jobId, job);
    logger.info(
      { jobId: job.jobId, type: job.type },
      "Job started"
    );

    try {
      const result = await this.handler(job);

      // Transition to COMPLETED
      job.status = "COMPLETED";
      job.result = result;
      job.completedAt = new Date().toISOString();
      this.jobs.set(job.jobId, job);
      logger.info(
        { jobId: job.jobId, type: job.type },
        "Job completed"
      );
    } catch (err) {
      // Transition to FAILED
      job.status = "FAILED";
      job.error = err instanceof Error ? err.message : String(err);
      job.completedAt = new Date().toISOString();
      this.jobs.set(job.jobId, job);
      logger.error(
        { jobId: job.jobId, type: job.type, error: job.error },
        "Job failed"
      );
    }
  }
}
