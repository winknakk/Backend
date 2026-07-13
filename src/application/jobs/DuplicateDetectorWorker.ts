import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { config } from "../../config/env";
import { createLogger } from "../../observability/logger";
import { runWithContext } from "../../kernel/context/RequestContextHolder";
import { TransactionManager } from "../../shared/repositories/TransactionManager";
import { UnitOfWork } from "../../shared/repositories/UnitOfWork";
import { PostgresTicketRepository } from "../../infrastructure/db/PostgresTicketRepository";
import { PostgresTicketEventRepository } from "../../infrastructure/db/PostgresTicketEventRepository";
import { TicketMapper } from "../../infrastructure/db/mappers/TicketMapper";
import { SubjectMatchingDuplicateStrategy } from "../../domain/strategies/DuplicateDetectionStrategy";

const logger = createLogger("DuplicateDetectorWorker");

export class DuplicateDetectorWorker {
  private worker: Worker;
  private redisConnection: Redis;

  constructor() {
    this.redisConnection = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });

    this.worker = new Worker(
      "ticket-duplicate-queue",
      async (job: Job) => {
        if (job.name !== "ticket.duplicate.check") return;

        const payload = job.data;
        const jobId = job.id || payload.metadata?.requestId;
        const lockKey = `processed:ticket:duplicate:${jobId}`;

        // 1. Idempotency Guard
        const setRes = await this.redisConnection.set(lockKey, "processing", "EX", 86400, "NX");
        if (setRes !== "OK") {
          logger.warn({ jobId }, "Duplicate check bypassed by Idempotency Guard");
          return;
        }

        try {
          const ticketId = payload.data?.ticketId;
          const projectId = String(payload.data?.projectId || "1");
          const correlationId = jobId || "unknown";

          const result = await runWithContext(
            {
              correlationId,
              projectId,
              clientChannel: "Queue",
              channelRef: "ai-worker",
            },
            async () => {
              const txManager = new TransactionManager();
              const uow = new UnitOfWork(txManager);
              const ticketRepo = new PostgresTicketRepository(txManager);
              const eventRepo = new PostgresTicketEventRepository(txManager);

              await uow.execute(
                async () => {
                  const ticket = await ticketRepo.findById(ticketId);
                  if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

                  logger.info({ ticketId }, "Checking for duplicate tickets");

                  // Fetch other active tickets in the project directly from database using active transaction client
                  const client = (txManager as any).activeClient || require("../../adapters/postgres/PostgresAdapter").pool;
                  const { rows } = await client.query(
                    `SELECT * FROM tickets 
                     WHERE project_id = $1 
                       AND LOWER(status) NOT IN ('closed', 'merged') 
                       AND id != $2`,
                    [ticket.projectId || 1, ticket.id]
                  );

                  const activeTickets = rows.map((r: any) => TicketMapper.toDomain(r));

                  // Pluggable strategy
                  const strategy = new SubjectMatchingDuplicateStrategy();
                  const dupResult = await strategy.detectDuplicate(ticket, activeTickets);

                  if (dupResult.isDuplicate && dupResult.duplicateOfTicketId) {
                    logger.info(
                      { ticketId, duplicateOf: dupResult.duplicateOfTicketId },
                      `Duplicate detected: marking ticket as duplicate of ${dupResult.duplicateOfTicketId}`
                    );

                    // Mark duplicate and transition status to merged
                    ticket.markDuplicate(
                      dupResult.duplicateOfTicketId,
                      dupResult.score,
                      dupResult.reason
                    );

                    // Update AI confidence duplicate metrics
                    (ticket as any)._aiConfidenceMetrics = {
                      ...ticket.aiConfidenceMetrics,
                      duplicate: dupResult.score,
                    };

                    uow.registerAggregate(ticket);
                    await ticketRepo.save(ticket);
                    await eventRepo.saveEvents(ticket, correlationId, "AI", "Queue");
                  } else {
                    logger.info({ ticketId }, "No duplicate ticket detected");
                  }
                }
              );
            }
          );

          await this.redisConnection.set(lockKey, "done", "EX", 86400);
          return result;
        } catch (err: any) {
          await this.redisConnection.del(lockKey);
          logger.error({ jobId, error: err.message }, "Error in DuplicateDetectorWorker loop");
          throw err;
        }
      },
      {
        connection: this.redisConnection as any,
        concurrency: 5,
      }
    );

    // DLQ Expiration Handling
    this.worker.on("failed", async (job, err) => {
      if (job && job.attemptsMade >= 3) {
        logger.error(
          { jobId: job.id, attemptsMade: job.attemptsMade, error: err.message },
          "CRITICAL: DuplicateDetectorWorker retry budget exhausted. Displacing failure context to DLQ key: queue:jobs:dlq"
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
      logger.error({ error: err.message }, "DuplicateDetectorWorker error");
    });
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.redisConnection.quit();
  }
}
