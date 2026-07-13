import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { config } from "../../config/env";
import { createLogger } from "../../observability/logger";
import { runWithContext } from "../../kernel/context/RequestContextHolder";
import { TransactionManager } from "../../shared/repositories/TransactionManager";
import { UnitOfWork } from "../../shared/repositories/UnitOfWork";
import { PostgresTicketRepository } from "../../infrastructure/db/PostgresTicketRepository";
import { PostgresTicketEventRepository } from "../../infrastructure/db/PostgresTicketEventRepository";
import { AiService } from "../../services/aiService";

const logger = createLogger("TicketTitleGeneratorWorker");

export class TicketTitleGeneratorWorker {
  private worker: Worker;
  private redisConnection: Redis;

  constructor() {
    this.redisConnection = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });

    this.worker = new Worker(
      "ticket-title-queue",
      async (job: Job) => {
        if (job.name !== "ticket.title.generate") return;

        const payload = job.data;
        const jobId = job.id || payload.metadata?.requestId;
        const lockKey = `processed:ticket:title:${jobId}`;

        // 1. Idempotency Guard
        const setRes = await this.redisConnection.set(lockKey, "processing", "EX", 86400, "NX");
        if (setRes !== "OK") {
          logger.warn({ jobId }, "Duplicate title generation bypassed by Idempotency Guard");
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

                  logger.info({ ticketId }, "Generating AI title for ticket");
                  const aiTitle = await AiService.generateTitle(ticket.subject, ticket.summary || "");

                  // Bypass private aggregate boundary cleanly using TypeScript cast
                  (ticket as any)._title = aiTitle;

                  // Trigger timeline event emission on aggregate root
                  ticket.updateSummary(ticket.runningSummary || "", ticket.lastAiSummary || "");

                  uow.registerAggregate(ticket);
                  await ticketRepo.save(ticket);
                  await eventRepo.saveEvents(ticket, correlationId, "AI", "Queue");
                }
              );

              logger.info({ ticketId }, "Successfully generated and saved AI title");
            }
          );

          await this.redisConnection.set(lockKey, "done", "EX", 86400);
          return result;
        } catch (err: any) {
          await this.redisConnection.del(lockKey);
          logger.error({ jobId, error: err.message }, "Error in TicketTitleGeneratorWorker loop");
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
          "CRITICAL: TicketTitleGeneratorWorker retry budget exhausted. Displacing failure context to DLQ key: queue:jobs:dlq"
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
      logger.error({ error: err.message }, "TicketTitleGeneratorWorker error");
    });
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.redisConnection.quit();
  }
}
