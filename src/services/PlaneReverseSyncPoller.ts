import { config } from "../config/env";
import { createLogger } from "../observability/logger";
import { PlaneWebhookService } from "./planeWebhookService";

const logger = createLogger("PlaneReverseSyncPoller");

export class PlaneReverseSyncPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

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
    this.running = true;
    try {
      const summary = await this.planeWebhookService.syncLinkedTicketsFromPlane();
      logger.info(summary, "Plane reverse sync polling completed");
    } catch (error: any) {
      logger.error({ error: error.message }, "Plane reverse sync polling failed");
    } finally {
      this.running = false;
    }
  }
}
