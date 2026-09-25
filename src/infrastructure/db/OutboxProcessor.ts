import os from "node:os";
import { PostgresOutboxRepository } from "./PostgresOutboxRepository";
import { QueueFactory } from "../../queue/QueueFactory";
import { IJobQueue } from "../../queue/types";
import { createLogger } from "../../observability/logger";
import { deletePlaneWorkItem } from "../../services/planeDeletionService";
import { PlaneService } from "../../services/planeService";
import { PostgresAdapter } from "../../adapters/postgres/PostgresAdapter";
import { classifyOutboxFailure, backoffMs, logClassification } from "./OutboxFailureClassifier";
import { traceRecorder } from "../../observability/TraceRecorder";
import { config } from "../../config/env";
import { KG_EVALUATE_JOB, KG_EVALUATION_EVENT, parseEvaluateJobData } from "../../application/jobs/KnowledgeGapWorker";

const logger = createLogger("OutboxProcessor");

/** Retry budget for failures that could plausibly succeed later. */
const MAX_TRANSIENT_ATTEMPTS = 5;

/** Which process dispatched an event — several backends share the outbox. */
const DISPATCHER = { host: os.hostname(), pid: process.pid };

/**
 * OutboxProcessor runs a background polling loop to process transactional
 * outbox events from the database and publish them to external systems.
 */
export class OutboxProcessor {
  private outboxRepo: PostgresOutboxRepository;
  private jobQueue: IJobQueue;
  private planeService: PlaneService;
  private intervalId: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(planeService?: PlaneService) {
    this.outboxRepo = new PostgresOutboxRepository();
    this.jobQueue = QueueFactory.getQueue();
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
          } else if (event_type === KG_EVALUATION_EVENT) {
            // A dead-lettered knowledge gap evaluation that an operator requeued.
            // Only ids travel; the worker re-reads the turn from the database.
            if ((config.QUEUE_PROVIDER || "").toLowerCase() !== "redis") {
              throw new Error("intelligence_queue_unavailable: knowledge gap evaluation requires QUEUE_PROVIDER=redis");
            }
            const turn = parseEvaluateJobData(payload);
            if (!turn) throw new Error("invalid payload: knowledge gap evaluation ids are missing in outbox payload");
            await this.jobQueue.enqueue({
              type: KG_EVALUATE_JOB,
              data: turn,
              // A fresh job id per replay: the original BullMQ job may still sit in
              // the failed set, and reusing its id would make the add a no-op.
              metadata: { requestId: `kg-eval-replay-${id}-${attempts}` },
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
            detail: { eventType: event_type, attempts, ...DISPATCHER },
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
            detail: { eventType: event_type, classification: kind, attempts: nextAttempts, ...DISPATCHER },
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
