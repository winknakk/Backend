import { pool } from "../../adapters/postgres/PostgresAdapter";
import { PlaneService } from "../../services/planeService";
import { PostgresAdapter } from "../../adapters/postgres/PostgresAdapter";
import { createLogger } from "../../observability/logger";

const logger = createLogger("OutboxProcessor");

/**
 * OutboxProcessor runs a background polling loop to process transactional
 * outbox events from the database and publish them to external systems.
 */
export class OutboxProcessor {
  private planeService: PlaneService;
  private intervalId: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor() {
    const adapter = new PostgresAdapter();
    this.planeService = new PlaneService(adapter);
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
      const { rows } = await pool.query(
        `SELECT id, event_type, payload, attempts FROM outbox_events
         WHERE status = 'pending'
         ORDER BY id ASC
         LIMIT 10`
      );

      if (rows.length === 0) {
        this.isProcessing = false;
        return;
      }

      logger.info({ count: rows.length }, "Processing outbox events");

      for (const row of rows) {
        const { id, event_type, payload, attempts } = row;
        const data = typeof payload === "string" ? JSON.parse(payload) : payload;

        try {
          // Process event based on type
          if (event_type === "TicketCreated") {
            const ticketId = data.ticketId;
            if (!ticketId) throw new Error("Ticket ID is missing in outbox payload");
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
            "Failed to process outbox event"
          );

          await pool.query(
            `UPDATE outbox_events SET status = $1, attempts = $2, error_message = $3, updated_at = NOW()
             WHERE id = $4`,
            [status, nextAttempts, err.message, id]
          );
        }
      }
    } catch (err: any) {
      logger.error({ error: err.message }, "Error fetching pending outbox events");
    } finally {
      this.isProcessing = false;
    }
  }
}
