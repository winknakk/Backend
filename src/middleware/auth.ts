import { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";

const logger = createLogger("auth");

/**
 * Fastify onRequest hook for Bearer token authentication.
 * If config.API_KEY is not set, validation is skipped (dev convenience).
 * The /health endpoint is always accessible without authentication.
 */
export async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Skip auth if no API_KEY is configured (dev convenience)
  if (!config.API_KEY) {
    return;
  }

  // Skip auth for health check and webhook endpoints
  if (request.url === "/health" || request.url === "/webhook/message") {
    return;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn({ url: request.url, ip: request.ip }, "Missing or malformed Authorization header");
    reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid or missing API key",
    });
    return;
  }

  const token = authHeader.slice(7); // Remove "Bearer " prefix
  if (token !== config.API_KEY) {
    logger.warn({ url: request.url, ip: request.ip }, "Invalid API key");
    reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid or missing API key",
    });
    return;
  }
}
