import { PostgresOutboxRepository } from "./PostgresOutboxRepository";
import { BullMQJobQueue } from "../queue/BullMQJobQueue";
import { createLogger } from "../../observability/logger";
import { deletePlaneWorkItem } from "../../services/planeDeletionService";
import { PlaneService } from "../../services/planeService";
import { PostgresAdapter } from "../../adapters/postgres/PostgresAdapter";
import { classifyOutboxFailure, backoffMs, logClassification } from "./OutboxFailureClassifier";
import { traceRecorder } from "../../observability/TraceRecorder";

const logger = createLogger("OutboxProcessor");

/** Retry budget for failures that could plausibly succeed later. */
const MAX_TRANSIENT_ATTEMPTS = 5;

/**
 * OutboxProcessor runs a background polling loop to process transactional
 * outbox events from the database and publish them to external systems.
 */
export class OutboxProcessor {
  private outboxRepo: PostgresOutboxRepository;
  private jobQueue: BullMQJobQueue;
  private planeService: PlaneService;
  private intervalId: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(planeService?: PlaneService) {
    this.outboxRepo = new PostgresOutboxRepository();
    this.jobQueue = new BullMQJobQueue();
    this.planeService = planeService || new PlaneService(new PostgresAdapter());
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
                projectId: String(payload.projectId || "1"),
              },
              metadata: {
                requestId: String(id),
              },
            });
          } else if (event_type === "PlaneWorkItemUpdateRequested") {
            const ticketId = String(payload.ticketId || payload.dbId);
            const newStatus = payload.newStatus;
            const newPriority = payload.newPriority;
            const oldStatus = payload.oldStatus;
            const oldPriority = payload.oldPriority;

            logger.info(
              { ticketId, newStatus, newPriority, outboxId: id },
              "Synchronizing Ticket status/priority update from DB to Plane Work Item"
            );

            if (newStatus && newStatus !== oldStatus) {
              await this.planeService.syncTicketStatusToPlane(ticketId, String(newStatus));
            }
            if (newPriority && newPriority !== oldPriority) {
              await this.planeService.syncTicketPriorityToPlane(ticketId, String(newPriority));
            }
          } else if (event_type === "PlaneWorkItemDeleteRequested") {
            const planeIssueId = payload.planeIssueId;
            if (!planeIssueId) throw new Error("Plane work-item ID is missing in outbox payload");

            logger.info({ planeIssueId, outboxId: id }, "Deleting Plane work item from Ticket deletion event");
            await deletePlaneWorkItem(String(planeIssueId), undefined, {
              projectId: payload.projectId,
              orgId: payload.orgId,
              planeWorkspaceSlug: payload.planeWorkspaceSlug,
              planeProjectId: payload.planeProjectId,
            });
          } else {
            logger.warn({ event_type }, "Unsupported outbox event type, skipping");
          }

          // Mark as processed
          await this.outboxRepo.markProcessed(id);

          // B-5: the outbox is a causal hop. Correlation comes from the
          // payload when the producer supplied one; it is not invented.
          await traceRecorder.record({
            correlationId: payload.correlationId || `outbox-${id}`,
            component: "outbox",
            eventType: `${event_type}_dispatched`,
            outboxEventId: Number(id),
            ticketId: Number(payload.ticketDbId) || null,
            projectId: payload.projectId ? Number(payload.projectId) : null,
            orgId: payload.orgId ?? null,
            detail: { eventType: event_type, attempts },
          });
        } catch (err: any) {
          const nextAttempts = attempts + 1;
          const kind = classifyOutboxFailure(err);
          logClassification(id, event_type, kind, err);

          await traceRecorder.record({
            correlationId: payload.correlationId || `outbox-${id}`,
            component: "outbox",
            eventType: `${event_type}_failed`,
            status: "failed",
            outboxEventId: Number(id),
            detail: { eventType: event_type, classification: kind, attempts: nextAttempts },
            errorMessage: err.message,
          });

          if (kind !== "transient") {
            // The payload is unacceptable, or the caller is not permitted.
            // Retrying cannot change either, and burning five attempts on it
            // only delays the events queued behind it. This is what left nine
            // "Custom Id cannot be integers" events cycling for 19 days.
            await this.outboxRepo.deadLetter(id, nextAttempts, err.message, kind);
          } else if (nextAttempts >= MAX_TRANSIENT_ATTEMPTS) {
            await this.outboxRepo.deadLetter(id, nextAttempts, err.message, "transient");
            logger.error(
              { id, event_type, attempts: nextAttempts },
              "Outbox event exhausted its retry budget and was dead-lettered"
            );
          } else {
            const delay = backoffMs(nextAttempts);
            await this.outboxRepo.scheduleRetry(id, nextAttempts, err.message, delay);
            logger.info({ id, event_type, attempts: nextAttempts, retryInMs: delay }, "Outbox retry scheduled");
          }
        }
      }
    } catch (err: any) {
      logger.error({ error: err.message }, "Error fetching pending outbox events");
    } finally {
      this.isProcessing = false;
    }
  }
}
