import { createLogger } from "../../observability/logger";
import { IJobQueue } from "../../queue/types";
import { KnowledgeGapService } from "../../services/KnowledgeGapService";
import { KG_CLUSTER_JOB, KG_EVALUATE_JOB } from "./KnowledgeGapWorker";

const logger = createLogger("KnowledgeGapSweepProducer");

export interface KnowledgeGapSweepOptions {
  /** How far back a sweep looks. Must stay below the queue's completed-job retention (24 h). */
  lookbackSeconds: number;
  /** Maximum turns enqueued per sweep. */
  batchLimit: number;
}

export const DEFAULT_SWEEP_OPTIONS: KnowledgeGapSweepOptions = {
  lookbackSeconds: 2 * 3600,
  batchLimit: 200,
};

/**
 * Producer for the Phase 3C knowledge-gap pipeline.
 *
 * Why a sweep and not a hook on message insertion: the approved "immediate
 * takeover" signal looks for a handoff up to 120 s *after* the customer
 * message, so a turn can only be judged once that window has closed. The
 * message insert sites are also the protected Flow 5/6 paths
 * (WebChatGateway, lineWebhook), which this phase must not touch.
 *
 * Idempotency: job ids are derived from the turn, so a turn seen by several
 * sweeps, or by several backend processes, is enqueued once while its job is
 * retained. PostgreSQL uniqueness on the candidate row remains authoritative.
 */
export class KnowledgeGapSweepProducer {
  private intervalId: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly queue: IJobQueue,
    private readonly service: KnowledgeGapService = new KnowledgeGapService(),
    private readonly options: KnowledgeGapSweepOptions = DEFAULT_SWEEP_OPTIONS
  ) {}

  static evaluateJobId(projectId: number, conversationId: number, messageId: number): string {
    return `kg-eval-${projectId}-${conversationId}-${messageId}`;
  }

  /** One clustering job per project per hour. */
  static clusterJobId(projectId: number, now: Date = new Date()): string {
    return `kg-cluster-${projectId}-${Math.floor(now.getTime() / 3600000)}`;
  }

  start(intervalMs: number = 60000): void {
    if (this.intervalId) return;
    logger.info({ intervalMs, ...this.options }, "Starting knowledge gap sweep producer");
    this.intervalId = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info("Stopped knowledge gap sweep producer");
    }
  }

  isRunning(): boolean {
    return this.intervalId !== null;
  }

  async runOnce(now: Date = new Date()): Promise<{ evaluateEnqueued: number; clusterEnqueued: number }> {
    if (this.running) return { evaluateEnqueued: 0, clusterEnqueued: 0 };
    this.running = true;
    let evaluateEnqueued = 0;
    let clusterEnqueued = 0;

    try {
      const turns = await this.service.findTurnsPendingEvaluation(this.options.lookbackSeconds, this.options.batchLimit);
      for (const turn of turns) {
        try {
          await this.queue.enqueue({
            type: KG_EVALUATE_JOB,
            data: { projectId: turn.projectId, conversationId: turn.conversationId, messageId: turn.messageId },
            metadata: { requestId: KnowledgeGapSweepProducer.evaluateJobId(turn.projectId, turn.conversationId, turn.messageId) },
          });
          evaluateEnqueued++;
        } catch (err: any) {
          logger.warn({ error: err.message, ...turn }, "Failed to enqueue knowledge gap evaluation");
        }
      }

      const projects = await this.service.findProjectsNeedingClustering();
      for (const projectId of projects) {
        try {
          await this.queue.enqueue({
            type: KG_CLUSTER_JOB,
            data: { projectId },
            metadata: { requestId: KnowledgeGapSweepProducer.clusterJobId(projectId, now) },
          });
          clusterEnqueued++;
        } catch (err: any) {
          logger.warn({ error: err.message, projectId }, "Failed to enqueue knowledge gap clustering");
        }
      }

      if (evaluateEnqueued || clusterEnqueued) {
        logger.info({ evaluateEnqueued, clusterEnqueued }, "Knowledge gap sweep enqueued work");
      }
    } catch (err: any) {
      logger.error({ error: err.message }, "Knowledge gap sweep failed");
    } finally {
      this.running = false;
    }

    return { evaluateEnqueued, clusterEnqueued };
  }
}
