import { IIntegrationEventPublisher } from "../../application/ports/IIntegrationEventPublisher";
import { BaseDomainEvent } from "../../shared/domain/BaseDomainEvent";
import { TicketCreatedEvent, TicketEnrichedEvent } from "../../domain/entities/TicketEvents";
import { BullMQJobQueue } from "./BullMQJobQueue";
import { createLogger } from "../../observability/logger";
import { ConfigLoaderService } from "../../services/ConfigLoaderService";

const logger = createLogger("BullMQEventPublisher");

/**
 * BullMQ implementation of IIntegrationEventPublisher.
 * Translates business domain events into asynchronous integration jobs.
 */
export class BullMQEventPublisher implements IIntegrationEventPublisher {
  private jobQueue: BullMQJobQueue;

  constructor() {
    this.jobQueue = new BullMQJobQueue();
  }

  /**
   * Translates and enqueues domain events to background queues.
   */
  async publish(events: BaseDomainEvent[]): Promise<void> {
    let isEnabled = false;
    try {
      // 1. Check local environment variable fallback
      if (process.env.ENABLE_BULLMQ_EVENT_DISPATCHER === "true") {
        isEnabled = true;
      } else {
        // 2. Check DB config with default project ID "1"
        const configLoader = ConfigLoaderService.getInstance();
        isEnabled = await configLoader.getFeatureFlag("1", "enable_bullmq_event_dispatcher");
      }
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to fetch feature flag enable_bullmq_event_dispatcher");
    }

    if (!isEnabled) {
      logger.info("BullMQ Event Publisher is disabled by feature flag.");
      return;
    }

    for (const event of events) {
      const eventId = event.getAggregateId();
      const startTime = Date.now();

      try {
        if (event instanceof TicketCreatedEvent) {
          logger.info({ eventId, readableId: event.readableId }, "Translating TicketCreatedEvent to BullMQ integration jobs");
          
          const projectIdStr = String(event.projectId || "1");

          // Enqueue ticket title generate job
          await this.jobQueue.enqueue({
            type: "ticket.title.generate",
            data: {
              ticketId: event.ticketId,
              projectId: projectIdStr,
            },
            metadata: {
              requestId: `title-${eventId}-${Date.now()}`,
            },
          });

          // Enqueue ticket duplicate check job
          await this.jobQueue.enqueue({
            type: "ticket.duplicate.check",
            data: {
              ticketId: event.ticketId,
              projectId: projectIdStr,
            },
            metadata: {
              requestId: `duplicate-${eventId}-${Date.now()}`,
            },
          });

          await this.jobQueue.enqueue({
            type: "ticket.summary.update",
            data: {
              ticketId: event.ticketId,
              projectId: projectIdStr,
              messageText: event.summary || event.subject,
            },
            metadata: {
              requestId: `summary-${eventId}-${Date.now()}`,
            },
          });

          logger.info(
            { durationMs: Date.now() - startTime, readableId: event.readableId },
            "Successfully published integration jobs for TicketCreatedEvent"
          );
        } else if (event instanceof TicketEnrichedEvent) {
          logger.info({ eventId, readableId: event.readableId }, "Publishing TicketEnrichedEvent for AutomationX");

          await this.jobQueue.enqueue({
            type: "TicketEnrichedEvent",
            data: {
              eventName: "TicketEnrichedEvent",
              ticketId: event.ticketId,
              ticketReadableId: event.readableId,
              conversationId: event.conversationId,
              projectId: String(event.projectId || "1"),
              enrichmentState: "COMPLETED",
              aiConfidenceMetrics: event.aiConfidenceMetrics,
              occurredAt: event.occurredAt.toISOString(),
            },
            metadata: {
              requestId: `ticket-enriched-${eventId}-${Date.now()}`,
            },
          });

          logger.info(
            { durationMs: Date.now() - startTime, readableId: event.readableId },
            "Successfully published TicketEnrichedEvent"
          );
        } else {
          logger.debug({ eventType: event.constructor.name }, "Unmapped domain event type, bypassing queue publication");
        }
      } catch (err: any) {
        logger.error(
          { eventId, error: err.message },
          "CRITICAL: Failed to publish integration event to BullMQ"
        );
      }
    }
  }
}
