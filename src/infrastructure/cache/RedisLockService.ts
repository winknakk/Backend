import Redis from "ioredis";
import { config } from "../../config/env";
import { createLogger } from "../../observability/logger";
import { randomUUID } from "crypto";

const logger = createLogger("RedisLockService");

/**
 * RedisLockService coordinates distributed locks (Redlock algorithm wrapper)
 * to guarantee concurrency safety across background jobs.
 */
export class RedisLockService {
  private redis: Redis;

  constructor() {
    this.redis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });
    this.redis.on("error", (err) => {
      logger.error({ error: err.message }, "RedisLockService connection error");
    });
  }

  /**
   * Acquires a lock for a key. Returns the ownership token (UUID) if successful, null if failed.
   */
  public async acquireLock(key: string, durationMs: number): Promise<string | null> {
    const token = randomUUID();
    const lockKey = `lock:${key}`;
    try {
      const result = await this.redis.set(lockKey, token, "PX", durationMs, "NX");
      if (result === "OK") {
        logger.info({ lockKey, token, durationMs }, "Lock acquired successfully");
        return token;
      }
      return null;
    } catch (err: any) {
      logger.error({ lockKey, error: err.message }, "Failed to acquire lock from Redis");
      return null;
    }
  }

  /**
   * Releases a lock safely using a Lua script to ensure ownership check.
   */
  public async releaseLock(key: string, token: string): Promise<boolean> {
    const lockKey = `lock:${key}`;
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    try {
      const result = await this.redis.eval(luaScript, 1, lockKey, token);
      const released = result === 1;
      if (released) {
        logger.info({ lockKey, token }, "Lock released successfully");
      } else {
        logger.warn(
          { lockKey, token },
          "Failed to release lock. Ownership mismatch or lock expired."
        );
      }
      return released;
    } catch (err: any) {
      logger.error({ lockKey, error: err.message }, "Failed to release lock in Redis");
      return false;
    }
  }

  /**
   * Disconnects the Redis connection client.
   */
  public async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}
