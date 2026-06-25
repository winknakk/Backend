import { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";

const logger = createLogger("rateLimit");

/** Sliding window request timestamps keyed by IP */
const requestMap = new Map<string, number[]>();

/**
 * Periodic cleanup interval to evict expired entries every 5 minutes.
 */
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  const windowMs = config.RATE_LIMIT_WINDOW_MS;

  for (const [key, timestamps] of requestMap.entries()) {
    const valid = timestamps.filter((t) => now - t < windowMs);
    if (valid.length === 0) {
      requestMap.delete(key);
    } else {
      requestMap.set(key, valid);
    }
  }

  logger.debug({ activeKeys: requestMap.size }, "Rate limit cleanup completed");
}, 5 * 60 * 1000); // 5 minutes

// Ensure the cleanup interval does not prevent Node from exiting
if (cleanupInterval.unref) {
  cleanupInterval.unref();
}

/**
 * Stop the periodic cleanup interval (useful for tests).
 */
export function stopCleanup(): void {
  clearInterval(cleanupInterval);
}

/**
 * Fastify onRequest hook for in-memory sliding window rate limiting.
 * Keyed by request.ip. Returns 429 when the limit is exceeded.
 */
export async function rateLimitHook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const key = request.ip;
  const now = Date.now();
  const windowMs = config.RATE_LIMIT_WINDOW_MS;
  const maxRequests = config.RATE_LIMIT_MAX;

  // Get existing timestamps and filter to current window
  const timestamps = (requestMap.get(key) || []).filter(
    (t) => now - t < windowMs
  );

  if (timestamps.length >= maxRequests) {
    // Calculate when the oldest request in the window expires
    const oldestInWindow = timestamps[0];
    const retryAfterMs = windowMs - (now - oldestInWindow);

    logger.warn(
      { ip: key, count: timestamps.length, maxRequests, retryAfterMs },
      "Rate limit exceeded"
    );

    reply.header("Retry-After", Math.ceil(retryAfterMs / 1000).toString());
    reply.status(429).send({
      error: "Too Many Requests",
      message: "Rate limit exceeded",
      retryAfterMs,
    });
    return;
  }

  // Record this request
  timestamps.push(now);
  requestMap.set(key, timestamps);
}
