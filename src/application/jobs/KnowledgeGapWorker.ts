import { Worker, Job, UnrecoverableError } from "bullmq";
import Redis from "ioredis";
import { createLogger } from "../../observability/logger";
import { createRedisClient } from "../../infrastructure/cache/createRedisClient";
import { INTELLIGENCE_CONFIG } from "../../config/intelligence";
import { KnowledgeGapService, KnowledgeGapTurnNotFoundError } from "../../services/KnowledgeGapService";
import { PostgresOutboxRepository } from "../../infrastructure/db/PostgresOutboxRepository";
import { classifyOutboxFailure } from "../../infrastructure/db/OutboxFailureClassifier";

const logger = createLogger("KnowledgeGapWorker");

export const KG_EVALUATE_JOB = "intelligence.knowledge_gap.evaluate";
export const KG_CLUSTER_JOB = "intelligence.knowledge_gap.cluster";
/** Outbox event type used as the replayable DLQ unit for a failed evaluation. */
export const KG_EVALUATION_EVENT = "KnowledgeGapEvaluationRequested";

/** Seconds a concurrency lock may outlive a crashed worker. */
const EVALUATE_LOCK_TTL_SECONDS = 120;

export interface KnowledgeGapEvaluateJobData {
  projectId: number;
  conversationId: number;
  messageId: number;
}

/** Positive-integer id triple, or null when the payload cannot identify a turn. */
export function parseEvaluateJobData(data: any): KnowledgeGapEvaluateJobData | null {
  const projectId = Number(data?.projectId);
  const conversationId = Number(data?.conversationId);
  const messageId = Number(data?.messageId);
  const ok = [projectId, conversationId, messageId].every((n) => Number.isInteger(n) && n > 0);
  return ok ? { projectId, conversationId, messageId } : null;
}

/** BullMQ emits `failed` after every attempt; only the last one is dead-lettered. */
export function isFinalAttempt(attemptsMade: number, maxAttempts: number | undefined, err: Error | undefined): boolean {
  if (err && (err instanceof UnrecoverableError || err.name === "UnrecoverableError")) return true;
  return attemptsMade >= (maxAttempts ?? 1);
}

export class KnowledgeGapWorker {
  private worker: Worker;
  private redisConnection: Redis;
  private knowledgeGapService: KnowledgeGapService;
  private outboxRepo: PostgresOutboxRepository;

  constructor(customService?: KnowledgeGapService, customOutboxRepo?: PostgresOutboxRepository) {
    this.knowledgeGapService = customService || new KnowledgeGapService();
    this.outboxRepo = customOutboxRepo || new PostgresOutboxRepository();
    this.redisConnection = createRedisClient("knowledge-gap-worker", {
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });

    this.worker = new Worker(INTELLIGENCE_CONFIG.queue.name, (job: Job) => this.process(job), {
      connection: this.redisConnection as any,
      concurrency: INTELLIGENCE_CONFIG.queue.concurrency,
    });

    this.worker.on("failed", (job, err) => {
      void this.handleFailed(job, err);
    });

    this.worker.on("error", (err) => {
      logger.error({ error: err.message }, "KnowledgeGapWorker encountered an error");
    });
  }

  private async process(job: Job): Promise<any> {
    const { name, data } = job;
    const jobId = job.id || "unknown";

    if (name === KG_EVALUATE_JOB) {
      const turn = parseEvaluateJobData(data);
      if (!turn) {
        throw new UnrecoverableError("invalid payload: knowledge gap evaluation requires positive projectId, conversationId and messageId");
      }
      const { projectId, conversationId, messageId } = turn;

      // Concurrency guard only. PostgreSQL uniqueness on
      // (project_id, conversation_id, message_id, model_version) is the
      // idempotency authority, so the lock is released as soon as the attempt
      // ends and a retry is never blocked by a stale "processing" marker.
      const lockKey = `lock:kg:eval:${projectId}:${conversationId}:${messageId}`;
      const setRes = await this.redisConnection.set(lockKey, String(jobId), "EX", EVALUATE_LOCK_TTL_SECONDS, "NX");
      if (setRes !== "OK") {
        logger.info({ jobId, lockKey }, "Knowledge gap evaluation already running for this turn; skipped");
        return { skipped: true, reason: "evaluation_in_progress" };
      }

      try {
        const result = await this.knowledgeGapService.evaluateTurn(projectId, conversationId, messageId);
        if (result.skipped !== undefined) {
          logger.info({ jobId, projectId, conversationId, messageId, reason: result.skipped }, "Knowledge gap evaluation skipped");
          return { skipped: true, reason: result.skipped };
        }
        logger.info(
          { jobId, projectId, conversationId, messageId, isCandidate: result.isCandidate, score: result.score },
          "Knowledge gap candidate evaluation complete"
        );
        return { isCandidate: result.isCandidate, score: result.score, candidateId: result.candidate?.id ?? null };
      } catch (err: any) {
        if (err instanceof KnowledgeGapTurnNotFoundError) {
          throw new UnrecoverableError(err.message);
        }
        logger.error({ error: err.message, jobId, projectId, conversationId }, "Failed to evaluate knowledge gap candidate in worker");
        throw err;
      } finally {
        await this.redisConnection.del(lockKey).catch(() => {});
      }
    }

    if (name === KG_CLUSTER_JOB) {
      const projectId = Number(data?.projectId);
      if (!Number.isInteger(projectId) || projectId <= 0) {
        throw new UnrecoverableError("invalid payload: clustering requires a positive projectId");
      }
      const lockKey = `processed:kg:cluster:${projectId}`;

      const setRes = await this.redisConnection.set(lockKey, "processing", "EX", 300, "NX");
      if (setRes !== "OK") {
        logger.info({ jobId, projectId }, "Clustering run already in progress; skipped");
        return { skipped: true, reason: "clustering_in_progress" };
      }

      try {
        const result = await this.knowledgeGapService.runClusteringForProject(projectId);
        logger.info(
          { jobId, projectId, clustersCreated: result.clustersCreated, similarityBasis: result.similarityBasis },
          "Clustering run completed"
        );
        return { clustersCreated: result.clustersCreated, similarityBasis: result.similarityBasis };
      } catch (err: any) {
        logger.error({ error: err.message, jobId, projectId }, "Failed to run clustering in worker");
        throw err;
      } finally {
        await this.redisConnection.del(lockKey).catch(() => {});
      }
    }

    logger.debug({ jobName: name }, "Ignored unrecognized job in conversation-intelligence-queue");
    return { ignored: true };
  }

  /**
   * After the final attempt, an evaluation is written to the Phase 2 outbox
   * dead-letter store so operators see it in the DLQ and can requeue it.
   * Clustering is recomputed by the next sweep and is not dead-lettered.
   */
  private async handleFailed(job: Job | undefined, err: Error): Promise<void> {
    if (!job || job.name !== KG_EVALUATE_JOB) return;
    if (!isFinalAttempt(job.attemptsMade, job.opts.attempts, err)) return;

    const turn = parseEvaluateJobData(job.data);
    try {
      const outboxId = await this.outboxRepo.recordDeadLetter({
        aggregateType: "conversation",
        aggregateId: String(turn?.conversationId ?? job.data?.conversationId ?? "unknown"),
        eventType: KG_EVALUATION_EVENT,
        // Ids only: the message text is re-read from the database on replay.
        payload: {
          projectId: turn?.projectId ?? null,
          conversationId: turn?.conversationId ?? null,
          messageId: turn?.messageId ?? null,
          bullJobId: job.id ?? null,
        },
        attempts: job.attemptsMade,
        errorMessage: String(err?.message || "unknown error"),
        failureKind: classifyOutboxFailure(err),
      });
      logger.warn({ jobId: job.id, outboxId, attempts: job.attemptsMade }, "Knowledge gap evaluation dead-lettered to outbox DLQ");
    } catch (dlqErr: any) {
      logger.error({ jobId: job.id, error: dlqErr.message }, "Failed to record knowledge gap dead letter");
    }
  }

  async close(): Promise<void> {
    logger.info("Closing KnowledgeGapWorker...");
    await this.worker.close();
    await this.redisConnection.quit();
    logger.info("KnowledgeGapWorker closed.");
  }
}
