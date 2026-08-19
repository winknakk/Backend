import { createLogger } from "../observability/logger";

const logger = createLogger("line-batch");

type BatchEntry = {
  timer: NodeJS.Timeout;
  events: Array<{
    event: any;
    decision: {
      projectId?: number;
      projectName?: string;
      conversationId?: number;
      pushOnboardingCarousel?: boolean;
    };
  }>;
  destination: string;
  dmGatewayUrl: string;
};

export type BatchConfig = {
  LINE_BATCH_ENABLED: boolean;
  LINE_BATCH_WINDOW_MS: number;
  LINE_DM_GATEWAY_WEBHOOK_URL: string;
};

/**
 * Debounces multiple LINE DM messages per user into a single batch,
 * then forwards them together to the PromptX DM Gateway as one request.
 *
 * This prevents the AI from sending one reply per message bubble when
 * a user sends several messages in quick succession.
 *
 * Storage: pure in-memory (Map + setTimeout). This is intentional —
 * the backend is a single Node.js process, and the trade-off of losing
 * an in-flight batch on a server restart is acceptable given the simplicity.
 */
export class LineMessageBatchingService {
  /**
   * Key format: `${destination}:${userId}`
   * This ensures batches are isolated per LINE channel destination.
   */
  private readonly batches = new Map<string, BatchEntry>();
  private readonly windowMs: number;
  private readonly dmGatewayUrl: string;

  constructor(config: BatchConfig) {
    this.windowMs = config.LINE_BATCH_WINDOW_MS;
    this.dmGatewayUrl = config.LINE_DM_GATEWAY_WEBHOOK_URL;
  }

  /**
   * Enqueues a LINE DM event for batched forwarding.
   *
   * If a timer is already running for this user, it is cancelled and reset,
   * extending the debounce window. The event is appended to the existing buffer.
   *
   * This method is intentionally synchronous (no await) so the caller can
   * respond HTTP 200 to LINE immediately without waiting for the batch window.
   */
  enqueue(
    userId: string,
    destination: string,
    event: any,
    decision: BatchEntry["events"][number]["decision"]
  ): void {
    const key = `${destination}:${userId}`;
    const existing = this.batches.get(key);

    if (existing) {
      clearTimeout(existing.timer);
      existing.events.push({ event, decision });
      existing.timer = setTimeout(() => this.flush(key), this.windowMs);
      logger.debug(
        { userId, destination, bufferSize: existing.events.length, windowMs: this.windowMs },
        "[line-batch] Timer reset — appended to existing batch"
      );
    } else {
      const timer = setTimeout(() => this.flush(key), this.windowMs);
      this.batches.set(key, {
        timer,
        events: [{ event, decision }],
        destination,
        dmGatewayUrl: this.dmGatewayUrl,
      });
      logger.debug(
        { userId, destination, windowMs: this.windowMs },
        "[line-batch] New batch started"
      );
    }
  }

  /**
   * Flushes all buffered events for a user immediately.
   * Called automatically by the debounce timer, or during graceful shutdown.
   */
  private async flush(key: string): Promise<void> {
    const entry = this.batches.get(key);
    if (!entry) return;

    this.batches.delete(key);
    clearTimeout(entry.timer);

    const { events, destination, dmGatewayUrl } = entry;
    const userId = key.split(":").slice(1).join(":"); // handle colons in userId

    logger.info(
      { userId, destination, batchSize: events.length },
      `[line-batch] Flushing ${events.length} event(s)`
    );

    // Use the decision metadata from the LAST event — it has the most up-to-date
    // project/conversation context after all messages have been processed.
    const lastDecision = events[events.length - 1].decision;
    const allLineEvents = events.map((e) => e.event);

    try {
      const axios = (await import("axios")).default;
      await axios.post(
        dmGatewayUrl,
        {
          destination,
          events: allLineEvents,
          ticketx: {
            onboardingVerified: true,
            projectId: lastDecision.projectId,
            projectName: lastDecision.projectName,
            conversationId: lastDecision.conversationId,
            batchSize: allLineEvents.length,
          },
        },
        { headers: { "Content-Type": "application/json" }, timeout: 15000 }
      );

      logger.info(
        { userId, destination, batchSize: allLineEvents.length },
        "[line-batch] Batch forwarded to PromptX gateway"
      );
    } catch (err: any) {
      logger.error(
        { userId, destination, batchSize: allLineEvents.length, error: err.message },
        "[line-batch] Failed to forward batch to PromptX gateway"
      );
    }

    // If the last event had a carousel flag, handle it separately via push
    // (this preserves the 24-hour recall carousel behavior)
    if (lastDecision.pushOnboardingCarousel && events[events.length - 1].event?.source?.userId) {
      const lineUserId = String(events[events.length - 1].event.source.userId);
      logger.info({ lineUserId }, "[line-batch] Carousel push deferred to caller — not triggered from batch flush");
      // NOTE: The carousel push is NOT done here because it requires LINE_CHANNEL_ACCESS_TOKEN
      // and the buildLineOnboardingCarousel function from lineWebhook.ts.
      // The caller (lineWebhook.ts) handles this immediately upon enqueue via a separate push call.
    }
  }

  /**
   * Graceful shutdown: flush all in-flight batches immediately.
   * Call this before closing the server to avoid losing pending messages.
   */
  async flushAll(): Promise<void> {
    const keys = Array.from(this.batches.keys());
    if (keys.length === 0) return;

    logger.info({ pendingBatches: keys.length }, "[line-batch] Graceful shutdown — flushing all pending batches");
    await Promise.allSettled(keys.map((key) => this.flush(key)));
  }

  /**
   * Returns the number of users with active pending batches.
   * Useful for health checks and observability.
   */
  getPendingCount(): number {
    return this.batches.size;
  }
}
