import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { config } from "../../config/env";
import { createLogger } from "../../observability/logger";
import { runWithContext } from "../../kernel/context/RequestContextHolder";
import { PlaneService } from "../../services/planeService";
import { PostgresAdapter } from "../../adapters/postgres/PostgresAdapter";

const logger = createLogger("PlaneSyncWorker");

/**
 * PlaneSyncWorker consumes integration job payloads to push new tickets to Plane.io.
 */
export class PlaneSyncWorker {
  private worker: Worker;
  private redisConnection: Redis;
  private planeService: PlaneService;

  constructor() {
    this.redisConnection = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });

    const adapter = new PostgresAdapter();
    this.planeService = new PlaneService(adapter);

    this.worker = new Worker(
      "ticket-plane-sync-queue",
      async (job: Job) => {
        if (job.name !== "ticket.sync.plane") return;

        const payload = job.data;
        const jobId = job.id || payload.metadata?.requestId;
        const lockKey = `processed:ticket:sync:plane:${jobId}`;

        // 1. Idempotency Guard
        const setRes = await this.redisConnection.set(lockKey, "processing", "EX", 300, "NX");
        if (setRes !== "OK") {
          logger.warn({ jobId }, "Plane sync check bypassed by Idempotency Guard");
          return;
        }

        try {
          const ticketId = payload.data?.ticketId;
          const projectId = String(payload.data?.projectId || "1");
          const correlationId = jobId || "unknown";

          if (!ticketId) {
            throw new Error("Ticket ID is missing in queue payload");
          }

          const result = await runWithContext(
            {
              correlationId,
              projectId,
              clientChannel: "Queue",
              channelRef: "plane-sync",
            },
            async () => {
              logger.info({ ticketId }, "Syncing ticket to Plane.io from queue payload");
              await this.planeService.promoteTicketToPlane(ticketId);
            }
          );

          await this.redisConnection.set(lockKey, "done", "EX", 300);
          return result;
        } catch (err: any) {
          await this.redisConnection.del(lockKey);
          logger.error({ jobId, error: err.message }, "Error in PlaneSyncWorker loop");
          throw err;
        }
      },
      {
        connection: this.redisConnection as any,
        concurrency: 2,
      }
    );

    // DLQ Expiration Handling
    this.worker.on("failed", async (job, err) => {
      if (job && job.attemptsMade >= 3) {
        logger.error(
          { jobId: job.id, attemptsMade: job.attemptsMade, error: err.message },
          "CRITICAL: PlaneSyncWorker retry budget exhausted. Displacing failure context to DLQ key: queue:jobs:dlq"
        );
        try {
          await this.redisConnection.rpush(
            "queue:jobs:dlq",
            JSON.stringify({
              jobId: job.id,
              payload: job.data,
              failedAt: new Date().toISOString(),
              error: err.message,
              attemptsMade: job.attemptsMade,
            })
          );
        } catch (dlqErr: any) {
          logger.error({ error: dlqErr.message }, "Failed to write job state to DLQ list key");
        }
      }
    });

    this.worker.on("error", (err) => {
      logger.error({ error: err.message }, "PlaneSyncWorker error");
    });
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.redisConnection.quit();
  }
}
