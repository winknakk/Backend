import Redis, { RedisOptions } from "ioredis";
import { config } from "../../config/env";
import { createLogger } from "../../observability/logger";

const logger = createLogger("redis-client");

/**
 * Creates an ioredis client with a connection-error listener already attached.
 *
 * Every client must have one. Without it ioredis emits
 * "[ioredis] Unhandled error event: connect ECONNREFUSED ..." on every retry,
 * which in a Redis-less environment produced a continuous flood of output —
 * dense enough to bury the fatal error behind RUN-02 — and risks surfacing as
 * an uncaught exception.
 *
 * `name` identifies the client in logs so a failing connection can be traced
 * back to the component that opened it.
 */
export function createRedisClient(name: string, options: RedisOptions = {}): Redis {
  const client = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    ...options,
  });

  let loggedFailure = false;

  client.on("error", (err: any) => {
    // Log the first failure at warn, then stay quiet until the connection
    // recovers. A down Redis otherwise emits one line per retry, forever.
    if (!loggedFailure) {
      loggedFailure = true;
      logger.warn({ client: name, error: err?.message, code: err?.code }, "Redis connection error");
    }
  });

  client.on("ready", () => {
    if (loggedFailure) {
      logger.info({ client: name }, "Redis connection recovered");
      loggedFailure = false;
    }
  });

  return client;
}
