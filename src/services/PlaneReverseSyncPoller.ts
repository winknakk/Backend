import { config } from "../config/env";
import { createLogger } from "../observability/logger";
import { PlaneWebhookService } from "./planeWebhookService";

const logger = createLogger("PlaneReverseSyncPoller");

export class PlaneReverseSyncPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Epoch ms before which no further polling is attempted. */
  private cooldownUntil = 0;

  constructor(private readonly planeWebhookService: PlaneWebhookService) {}

  start(): void {
    if (!config.PLANE_REVERSE_SYNC_ENABLED || this.timer) return;

    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), config.PLANE_REVERSE_SYNC_INTERVAL_MS);
    this.timer.unref();
    logger.info(
      {
        intervalMs: config.PLANE_REVERSE_SYNC_INTERVAL_MS,
        batchSize: config.PLANE_REVERSE_SYNC_BATCH_SIZE,
      },
      "Plane reverse sync polling started"
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;

    // Respect a cooldown imposed by Plane rate limiting. Polling straight
    // through a 429 is what turned a healthy cycle into one where most items
    // failed: the poller re-fetched all 19 linked work items every 30
    // seconds and Plane progressively throttled it.
    if (Date.now() < this.cooldownUntil) {
      logger.debug(
        { resumesInMs: this.cooldownUntil - Date.now() },
        "Plane reverse sync is in rate-limit cooldown; skipping this cycle"
      );
      return;
    }

    this.running = true;
    try {
      const summary = await this.planeWebhookService.syncLinkedTicketsFromPlane();

      if (summary.rateLimited) {
        this.cooldownUntil = Date.now() + (summary.retryAfterMs || 60_000);
        logger.warn(
          { ...summary, cooldownMs: summary.retryAfterMs },
          "Plane reverse sync paused after rate limiting"
        );
      } else {
        this.cooldownUntil = 0;
        logger.info(summary, "Plane reverse sync polling completed");
      }
    } catch (error: any) {
      logger.error({ error: error.message }, "Plane reverse sync polling failed");
    } finally {
      this.running = false;
    }
  }
}
