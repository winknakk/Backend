import { DatabaseAdapter } from "../adapters/types";
import { createLogger } from "../observability/logger";
import { pool } from "../adapters/postgres/PostgresAdapter";

const logger = createLogger("InactivityTimerService");

export class InactivityTimerService {
  private checkIntervalTimer: NodeJS.Timeout | null = null;
  private readonly INACTIVITY_THRESHOLD_MINUTES = 15;

  constructor(private dbAdapter: DatabaseAdapter) {}

  /**
   * Starts the 15-minute inactivity monitor background polling interval (runs every 60 seconds).
   */
  startMonitor(intervalMs = 60000): void {
    if (this.checkIntervalTimer) return;
    logger.info({ intervalMs }, "Starting 15-minute Inactivity Timer Service...");

    this.checkIntervalTimer = setInterval(async () => {
      try {
        await this.checkAndReturnToAI();
      } catch (err: any) {
        logger.error({ error: err.message }, "Error during inactivity timer check");
      }
    }, intervalMs);
  }

  /**
   * Stops the background monitor.
   */
  stopMonitor(): void {
    if (this.checkIntervalTimer) {
      clearInterval(this.checkIntervalTimer);
      this.checkIntervalTimer = null;
      logger.info("Inactivity Timer Service stopped.");
    }
  }

  /**
   * Queries human-handled conversations where updated_at > 15 minutes ago,
   * and automatically resets them back to handled_by = 'ai'.
   */
  async checkAndReturnToAI(): Promise<{ returnedCount: number; conversationIds: string[] }> {
    try {
      const res = await pool.query(`
        SELECT id, channel, project_id, org_id
        FROM conversations
        WHERE handled_by = 'human'
          AND updated_at < NOW() - INTERVAL '15 minutes'
          AND deleted_at IS NULL
      `);

      const expiredConversations = res.rows;
      const conversationIds: string[] = [];

      for (const conv of expiredConversations) {
        const convId = String(conv.id);
        logger.info(
          { conversationId: convId, orgId: conv.org_id },
          `Conversation #${convId} inactive for > 15 minutes. Returning control to AI.`
        );

        // Reset handled_by to 'ai'
        await this.dbAdapter.updateHandoffState(convId, "ai");
        conversationIds.push(convId);
      }

      return { returnedCount: conversationIds.length, conversationIds };
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to query or update inactive conversations");
      return { returnedCount: 0, conversationIds: [] };
    }
  }
}
