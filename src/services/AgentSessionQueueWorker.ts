import axios from "axios";
import { AgentSessionQueueService, QueueItem } from "./AgentSessionQueueService";
import { createLogger } from "../observability/logger";

const logger = createLogger("agent-session-worker");

export interface WorkerConfig {
  dmGatewayUrl: string;
  leaseDurationMs?: number;
  maxAttempts?: number;
  watchdogIntervalMs?: number;
}

export class AgentSessionQueueWorker {
  private readonly dmGatewayUrl: string;
  private readonly leaseDurationMs: number;
  private readonly maxAttempts: number;
  private readonly activeDispatches = new Set<number>();
  private watchdogTimer: NodeJS.Timeout | null = null;
  private isStopping = false;

  constructor(
    private readonly queueService: AgentSessionQueueService,
    config: WorkerConfig
  ) {
    this.dmGatewayUrl = config.dmGatewayUrl;
    this.leaseDurationMs = config.leaseDurationMs || 120000;
    this.maxAttempts = config.maxAttempts || 2;

    if (config.watchdogIntervalMs && config.watchdogIntervalMs > 0) {
      this.startWatchdog(config.watchdogIntervalMs);
    }
  }

  /**
   * Dispatches the worker loop for a specific conversation.
   * If a worker is already actively processing this conversation,
   * this call returns immediately; the active loop will drain the queue.
   */
  async dispatchConversation(conversationId: number): Promise<void> {
    if (this.isStopping) return;

    if (this.activeDispatches.has(conversationId)) {
      logger.debug(
        { conversationId },
        "[agent-worker] Dispatch skipped: worker loop already active for conversation"
      );
      return;
    }

    this.activeDispatches.add(conversationId);
    try {
      await this.processConversationLoop(conversationId);
    } finally {
      this.activeDispatches.delete(conversationId);
    }
  }

  /**
   * Internal sequential loop that processes one turn at a time for the conversation
   * until all queued messages are processed.
   */
  private async processConversationLoop(conversationId: number): Promise<void> {
    let currentItem: QueueItem | null = await this.queueService.claimNext(
      conversationId,
      this.leaseDurationMs
    );

    while (currentItem && !this.isStopping) {
      const queueItemId = currentItem.id;
      const leaseToken = currentItem.lease_token;

      if (!leaseToken) {
        logger.error(
          { queueItemId, conversationId },
          "[agent-worker] Claimed item missing lease_token"
        );
        break;
      }

      logger.info(
        { queueItemId, conversationId, attemptCount: currentItem.attempt_count },
        "[agent-worker] Starting Agent execution turn"
      );

      try {
        // Execute the Agent turn by sending the queued payload to the PromptX Gateway
        // We set axios timeout slightly below lease duration so request fails before lease expires
        const requestTimeout = Math.max(this.leaseDurationMs - 5000, 10000);

        await axios.post(this.dmGatewayUrl, currentItem.payload, {
          headers: {
            "Content-Type": "application/json",
            "X-TicketX-Queue-Item-Id": String(queueItemId),
            "X-TicketX-Conversation-Id": String(conversationId),
          },
          timeout: requestTimeout,
        });

        logger.info(
          { queueItemId, conversationId },
          "[agent-worker] Agent turn completed successfully"
        );

        // Atomically complete this item and claim the next item if available
        currentItem = await this.queueService.completeAndClaimNext(
          conversationId,
          queueItemId,
          leaseToken,
          this.leaseDurationMs
        );
      } catch (err: any) {
        logger.error(
          {
            queueItemId,
            conversationId,
            error: err.message,
            statusCode: err.response?.status,
            responseData: err.response?.data,
          },
          "[agent-worker] Agent execution turn failed"
        );

        const errorDetail = err.response?.data
          ? typeof err.response.data === "string"
            ? err.response.data
            : JSON.stringify(err.response.data)
          : err.message;

        await this.queueService.failAndRelease(
          conversationId,
          queueItemId,
          leaseToken,
          errorDetail,
          this.maxAttempts
        );

        // Terminate loop on failure to prevent rapid failure loops
        break;
      }
    }
  }

  /**
   * Starts periodic watchdog to recover expired leases and process stalled queues.
   */
  startWatchdog(intervalMs = 30000): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);

    this.watchdogTimer = setInterval(async () => {
      try {
        const { recoveredCount, conversationIds } = await this.queueService.recoverExpiredLeases(this.maxAttempts);
        if (recoveredCount > 0) {
          logger.info(
            { recoveredCount },
            "[agent-worker] Watchdog recovered expired leases; checking pending queues"
          );
          await Promise.allSettled(conversationIds.map((conversationId) => this.dispatchConversation(conversationId)));
        }
      } catch (err: any) {
        logger.error({ error: err.message }, "[agent-worker] Watchdog recovery error");
      }
    }, intervalMs);

    logger.info({ intervalMs }, "[agent-worker] Started lease recovery watchdog");
  }

  /**
   * Stops the worker and clears watchdog.
   */
  async stop(): Promise<void> {
    this.isStopping = true;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    logger.info("[agent-worker] Stopped agent session queue worker");
  }

  /**
   * Returns active in-process conversation dispatches count.
   */
  getActiveDispatchCount(): number {
    return this.activeDispatches.size;
  }
}
