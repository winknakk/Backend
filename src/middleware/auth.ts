import { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";

const logger = createLogger("auth");

/**
 * Fastify onRequest hook for Bearer token authentication.
 * In production, API_KEY is required. In development, auth is skipped with a warning.
 * The /health endpoint is always accessible without authentication.
 */
export async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Skip auth if no API_KEY is configured
  if (!config.API_KEY) {
    if (config.NODE_ENV === "production") {
      logger.error("SECURITY: API_KEY is not configured in production. Rejecting all authenticated requests.");
      reply.status(503).send({
        error: "Service Unavailable",
        message: "Server authentication is not configured",
      });
      return;
    }
    // Development mode: allow but log warning
    return;
  }

  // Skip auth for health check, webhook, public auth, and public media endpoints
  if (
    request.url === "/health" ||
    request.url === "/webhook/message" ||
    request.url.startsWith("/api/v1/auth/") ||
    request.url.startsWith("/api/v1/webchat") ||
    request.url.startsWith("/api/v1/webhooks") ||
    request.url.startsWith("/api/v1/media/")
  ) {
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
