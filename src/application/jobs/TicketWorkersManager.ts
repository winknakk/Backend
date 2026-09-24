import { TicketTitleGeneratorWorker } from "./TicketTitleGeneratorWorker";
import { TicketSummaryWorker } from "./TicketSummaryWorker";
import { DuplicateDetectorWorker } from "./DuplicateDetectorWorker";
import { PlaneSyncWorker } from "./PlaneSyncWorker";
import { KnowledgeGapWorker } from "./KnowledgeGapWorker";
import { KnowledgeGapSweepProducer } from "./KnowledgeGapSweepProducer";
import { createLogger } from "../../observability/logger";

const logger = createLogger("TicketWorkersManager");

export class TicketWorkersManager {
  private static titleWorker: TicketTitleGeneratorWorker | null = null;
  private static summaryWorker: TicketSummaryWorker | null = null;
  private static duplicateWorker: DuplicateDetectorWorker | null = null;
  private static planeWorker: PlaneSyncWorker | null = null;
  private static knowledgeGapWorker: KnowledgeGapWorker | null = null;
  private static knowledgeGapProducer: KnowledgeGapSweepProducer | null = null;

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
    this.knowledgeGapWorker = new KnowledgeGapWorker();
    // Required lazily: QueueFactory -> BullMQJobQueue -> TicketWorkersManager.
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- breaks the import cycle above
    const { QueueFactory } = require("../../queue/QueueFactory");
    this.knowledgeGapProducer = new KnowledgeGapSweepProducer(QueueFactory.getQueue());
    this.knowledgeGapProducer.start();
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
    if (this.knowledgeGapProducer) {
      this.knowledgeGapProducer.stop();
      this.knowledgeGapProducer = null;
    }
    if (this.knowledgeGapWorker) {
      await this.knowledgeGapWorker.close();
      this.knowledgeGapWorker = null;
    }
    logger.info("Ticket Intelligence Workers shut down cleanly.");
  }

  static getStatus(): { titleWorker: string; summaryWorker: string; duplicateWorker: string; planeWorker: string; knowledgeGapWorker: string; knowledgeGapProducer: string } {
    return {
      titleWorker: this.titleWorker !== null ? "ACTIVE" : "STOPPED",
      summaryWorker: this.summaryWorker !== null ? "ACTIVE" : "STOPPED",
      duplicateWorker: this.duplicateWorker !== null ? "ACTIVE" : "STOPPED",
      planeWorker: this.planeWorker !== null ? "ACTIVE" : "STOPPED",
      knowledgeGapWorker: this.knowledgeGapWorker !== null ? "ACTIVE" : "STOPPED",
      knowledgeGapProducer: this.knowledgeGapProducer?.isRunning() ? "ACTIVE" : "STOPPED",
    };
  }
}
