import crypto from "crypto";
import { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";

const logger = createLogger("webhookSignature");

/**
 * Fastify onRequest hook for HMAC-SHA256 webhook signature validation.
 * Only validates POST requests to "/webhook/message".
 * If config.WEBHOOK_SECRET is not set, validation is skipped.
 */
export async function webhookSignatureHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Skip if no webhook secret is configured
  if (!config.WEBHOOK_SECRET) {
    return;
  }

  // Only validate POST requests to the webhook endpoint
  if (request.method !== "POST" || request.url !== "/webhook/message") {
    return;
  }

  const signature = request.headers["x-signature"] as string | undefined;
  if (!signature) {
    logger.warn({ url: request.url, ip: request.ip }, "Missing x-signature header");
    reply.status(403).send({
      error: "Forbidden",
      message: "Invalid webhook signature",
    });
    return;
  }

  const rawBody = JSON.stringify(request.body);
  const expectedSignature = crypto.createHmac("sha256", config.WEBHOOK_SECRET).update(rawBody).digest("hex");

  const sigBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expectedSignature, "hex");

  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    logger.warn({ url: request.url, ip: request.ip }, "Invalid webhook signature");
    reply.status(403).send({
      error: "Forbidden",
      message: "Invalid webhook signature",
    });
    return;
  }

  logger.debug({ url: request.url }, "Webhook signature verified");
}
