import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { config } from "../../config/env";
import { createLogger } from "../../observability/logger";
import { runWithContext } from "../../kernel/context/RequestContextHolder";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { PlaneService } from "../../services/planeService";
import { PostgresAdapter } from "../../adapters/postgres/PostgresAdapter";

const logger = createLogger("PlaneSyncWorker");

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
          const projectId = String(payload.data?.projectId || "1");
          const correlationId = jobId || "unknown";

          const result = await runWithContext(
            {
              correlationId,
              projectId,
              clientChannel: "Queue",
              channelRef: "plane-sync",
            },
            async () => {
              // Fetch pending outbox events
              const { rows } = await pool.query(
                `SELECT id, event_type, payload, attempts FROM outbox_events
                 WHERE status = 'pending'
                 ORDER BY id ASC
                 LIMIT 10`
              );

              if (rows.length === 0) {
                logger.info("No pending outbox events found for Plane sync");
                return;
              }

              logger.info({ count: rows.length }, "Processing outbox events inside PlaneSyncWorker");

              for (const row of rows) {
                const { id, event_type, payload: eventPayload, attempts } = row;
                const data = typeof eventPayload === "string" ? JSON.parse(eventPayload) : eventPayload;

                try {
                  if (event_type === "TicketCreated") {
                    const ticketId = data.ticketId;
                    if (!ticketId) throw new Error("Ticket ID is missing in outbox payload");

                    logger.info({ ticketId }, "Syncing ticket to Plane.io");
                    await this.planeService.promoteTicketToPlane(ticketId);
                  } else {
                    logger.warn({ event_type }, "Unsupported outbox event type, skipping");
                  }

                  // Mark as processed
                  await pool.query(
                    `UPDATE outbox_events SET status = 'processed', updated_at = NOW() WHERE id = $1`,
                    [id]
                  );
                } catch (err: any) {
                  const nextAttempts = attempts + 1;
                  const status = nextAttempts >= 5 ? "failed" : "pending";

                  logger.error(
                    { id, event_type, attempts: nextAttempts, error: err.message, status },
                    "Failed to process outbox event in PlaneSyncWorker"
                  );

                  await pool.query(
                    `UPDATE outbox_events SET status = $1, attempts = $2, error_message = $3, updated_at = NOW()
                     WHERE id = $4`,
                    [status, nextAttempts, err.message, id]
                  );
                }
              }
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
