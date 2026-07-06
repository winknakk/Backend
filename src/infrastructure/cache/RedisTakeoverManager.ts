import Redis from "ioredis";
import { config } from "../../config/env";
import { getProjectId } from "../../kernel/context/RequestContextHolder";
import { createLogger } from "../../observability/logger";

const logger = createLogger("RedisTakeoverManager");

export class RedisTakeoverManager {
  private redis: Redis;

  constructor() {
    this.redis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });
    this.redis.on("error", (err) => {
      logger.error({ error: err.message }, "RedisTakeoverManager Redis connection error");
    });
  }

  private getLeaseKey(conversationId: string): string {
    const projectId = getProjectId() || "1";
    return `project:${projectId}:takeover:${conversationId}`;
  }

  /**
   * Acquires a takeover session lease in Redis for a specific duration.
   */
  async acquireLease(convId: string, agentId: string, durationMs: number): Promise<void> {
    const key = this.getLeaseKey(convId);
    const expiresAt = Date.now() + durationMs;
    const value = JSON.stringify({ agentId, expiresAt });
    const ttlSeconds = Math.max(1, Math.ceil(durationMs / 1000));
    await this.redis.setex(key, ttlSeconds, value);
    logger.info({ convId, agentId, durationMs, key }, "Acquired takeover lease in Redis");
  }

  /**
   * Deletes a takeover lease immediately.
   */
  async releaseLease(convId: string): Promise<void> {
    const key = this.getLeaseKey(convId);
    await this.redis.del(key);
    logger.info({ convId, key }, "Released takeover lease in Redis");
  }

  /**
   * Checks the current state of a takeover lease lock.
   */
  async checkLeaseStatus(convId: string): Promise<{ active: boolean; agentId?: string; expiresAt?: number }> {
    const key = this.getLeaseKey(convId);
    const raw = await this.redis.get(key);
    if (!raw) {
      return { active: false };
    }
    try {
      const data = JSON.parse(raw);
      const now = Date.now();
      if (now > data.expiresAt) {
        await this.redis.del(key);
        return { active: false };
      }
      return {
        active: true,
        agentId: data.agentId,
        expiresAt: data.expiresAt,
      };
    } catch (err: any) {
      logger.warn({ key, error: err.message }, "Failed to parse lease from Redis. Reverting to inactive.");
      return { active: false };
    }
  }

  /**
   * Disconnects the Redis connection client.
   */
  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}
