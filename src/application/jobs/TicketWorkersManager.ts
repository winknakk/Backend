import { TicketTitleGeneratorWorker } from "./TicketTitleGeneratorWorker";
import { TicketSummaryWorker } from "./TicketSummaryWorker";
import { DuplicateDetectorWorker } from "./DuplicateDetectorWorker";
import { PlaneSyncWorker } from "./PlaneSyncWorker";
import { createLogger } from "../../observability/logger";

const logger = createLogger("TicketWorkersManager");

export class TicketWorkersManager {
  private static titleWorker: TicketTitleGeneratorWorker | null = null;
  private static summaryWorker: TicketSummaryWorker | null = null;
  private static duplicateWorker: DuplicateDetectorWorker | null = null;
  private static planeWorker: PlaneSyncWorker | null = null;

  static start(): void {
    if (this.titleWorker) {
      logger.warn("Ticket workers already started");
      return;
    }

    logger.info("Initializing Ticket Intelligence Workers...");
    this.titleWorker = new TicketTitleGeneratorWorker();
    this.summaryWorker = new TicketSummaryWorker();
    this.duplicateWorker = new DuplicateDetectorWorker();
    this.planeWorker = new PlaneSyncWorker();
    logger.info("Ticket Intelligence Workers initialized successfully!");
  }

  static async stop(): Promise<void> {
    logger.info("Shutting down Ticket Intelligence Workers...");
    if (this.titleWorker) {
      await this.titleWorker.close();
      this.titleWorker = null;
    }
    if (this.summaryWorker) {
      await this.summaryWorker.close();
      this.summaryWorker = null;
    }
    if (this.duplicateWorker) {
      await this.duplicateWorker.close();
      this.duplicateWorker = null;
    }
    if (this.planeWorker) {
      await this.planeWorker.close();
      this.planeWorker = null;
    }
    logger.info("Ticket Intelligence Workers shut down cleanly.");
  }
}
