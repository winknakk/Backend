import Redis from "ioredis";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";

const logger = createLogger("CacheService");

export class CacheService {
  private static instance: CacheService;
  private redisClient: Redis | null = null;
  private memoryCache = new Map<string, { value: any; expiresAt: number }>();

  // Metrics: tenantId -> count
  private hitsMap = new Map<string, number>();
  private missesMap = new Map<string, number>();

  private constructor() {
    const provider = config.CACHE_PROVIDER || "memory";
    if (provider === "redis") {
      logger.info(`Initializing Redis Cache Provider with URL: ${config.REDIS_URL}`);
      this.redisClient = new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: 3,
        enableOfflineQueue: false,
      });
      this.redisClient.on("error", (err) => {
        logger.error({ error: err.message }, "Redis cache client connection error");
      });
    } else {
      logger.info("Initializing In-Memory Cache Provider");
    }
  }

  static getInstance(): CacheService {
    if (!CacheService.instance) {
      CacheService.instance = new CacheService();
    }
    return CacheService.instance;
  }

  private extractTenantId(key: string): string {
    const match = key.match(/^tenant:([^:]+)/);
    return match ? match[1] : "global";
  }

  async get<T>(key: string): Promise<T | null> {
    const tenantId = this.extractTenantId(key);

    if (this.redisClient) {
      try {
        const raw = await this.redisClient.get(key);
        if (raw !== null) {
          this.hitsMap.set(tenantId, (this.hitsMap.get(tenantId) || 0) + 1);
          return JSON.parse(raw) as T;
        }
      } catch (err: any) {
        logger.warn({ key, error: err.message }, "Failed to get from Redis cache. Falling back.");
      }
    } else {
      const cached = this.memoryCache.get(key);
      if (cached) {
        if (Date.now() < cached.expiresAt) {
          this.hitsMap.set(tenantId, (this.hitsMap.get(tenantId) || 0) + 1);
          return cached.value as T;
        } else {
          this.memoryCache.delete(key); // Evict expired
        }
      }
    }

    this.missesMap.set(tenantId, (this.missesMap.get(tenantId) || 0) + 1);
    return null;
  }

  async set<T>(key: string, value: T, ttlSeconds: number = 300): Promise<void> {
    if (this.redisClient) {
      try {
        await this.redisClient.setex(key, ttlSeconds, JSON.stringify(value));
      } catch (err: any) {
        logger.warn({ key, error: err.message }, "Failed to set value in Redis cache.");
      }
    } else {
      this.memoryCache.set(key, {
        value,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    }
  }

  async delete(key: string): Promise<void> {
    if (this.redisClient) {
      try {
        await this.redisClient.del(key);
      } catch (err: any) {
        logger.warn({ key, error: err.message }, "Failed to delete key in Redis cache.");
      }
    } else {
      this.memoryCache.delete(key);
    }
  }

  async clear(): Promise<void> {
    if (this.redisClient) {
      try {
        await this.redisClient.flushdb();
      } catch (err: any) {
        logger.warn({ error: err.message }, "Failed to flush Redis cache.");
      }
    } else {
      this.memoryCache.clear();
    }
    this.hitsMap.clear();
    this.missesMap.clear();
  }

  getMetrics() {
    const tenants = Array.from(new Set([...this.hitsMap.keys(), ...this.missesMap.keys()]));
    const metrics: Record<string, { hits: number; misses: number; ratio: number }> = {};

    for (const t of tenants) {
      const hits = this.hitsMap.get(t) || 0;
      const misses = this.missesMap.get(t) || 0;
      const total = hits + misses;
      metrics[t] = {
        hits,
        misses,
        ratio: total > 0 ? parseFloat((hits / total).toFixed(2)) : 0,
      };
    }

    return metrics;
  }

  async disconnect(): Promise<void> {
    if (this.redisClient) {
      await this.redisClient.quit();
      this.redisClient = null;
      logger.info("Redis cache client disconnected successfully.");
    }
  }

  // Exposed for testing
  isRedisActive(): boolean {
    return this.redisClient !== null && this.redisClient.status === "ready";
  }
}
