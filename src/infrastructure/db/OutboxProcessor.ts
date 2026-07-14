import { PostgresOutboxRepository } from "./PostgresOutboxRepository";
import { BullMQJobQueue } from "../queue/BullMQJobQueue";
import { createLogger } from "../../observability/logger";

const logger = createLogger("OutboxProcessor");

/**
 * OutboxProcessor runs a background polling loop to process transactional
 * outbox events from the database and publish them to external systems.
 */
export class OutboxProcessor {
  private outboxRepo: PostgresOutboxRepository;
  private jobQueue: BullMQJobQueue;
  private intervalId: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor() {
    this.outboxRepo = new PostgresOutboxRepository();
    this.jobQueue = new BullMQJobQueue();
  }

  /**
   * Starts the background outbox processing loop.
   */
  public start(intervalMs: number = 5000): void {
    if (this.intervalId) return;
    logger.info("Starting background transactional Outbox Processor loop...");
    this.intervalId = setInterval(() => this.processPendingEvents(), intervalMs);
  }

  /**
   * Stops the outbox processing loop.
   */
  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info("Stopped background transactional Outbox Processor loop.");
    }
  }

  /**
   * Fetches and processes pending outbox events.
   */
  public async processPendingEvents(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const pendingEvents = await this.outboxRepo.fetchPending(10);

      if (pendingEvents.length === 0) {
        this.isProcessing = false;
        return;
      }

      logger.info({ count: pendingEvents.length }, "Processing outbox events");

      for (const event of pendingEvents) {
        const { id, event_type, payload, attempts } = event;

        try {
          // Process event based on type
          if (event_type === "TicketCreated") {
            const ticketId = payload.ticketId;
            if (!ticketId) throw new Error("Ticket ID is missing in outbox payload");

            logger.info({ ticketId, outboxId: id }, "Dispatching ticket.sync.plane job from Outbox");
            await this.jobQueue.enqueue({
              type: "ticket.sync.plane",
              data: {
                ticketId,
                projectId: "1",
              },
              metadata: {
                requestId: String(id),
              },
            });
          } else {
            logger.warn({ event_type }, "Unsupported outbox event type, skipping");
          }

          // Mark as processed
          await this.outboxRepo.markProcessed(id);
        } catch (err: any) {
          const nextAttempts = attempts + 1;
          const status = nextAttempts >= 5 ? "failed" : "pending";

          logger.error(
            { id, event_type, attempts: nextAttempts, error: err.message, status },
            "Failed to process outbox event"
          );

          await this.outboxRepo.updateAttempts(id, nextAttempts, err.message, status);
        }
      }
    } catch (err: any) {
      logger.error({ error: err.message }, "Error fetching pending outbox events");
    } finally {
      this.isProcessing = false;
    }
  }
}
