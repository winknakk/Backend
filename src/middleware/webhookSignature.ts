import crypto from "crypto";
import { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";

const logger = createLogger("webhookSignature");

/**
 * Routes carrying their own webhook authentication.
 *
 * `/webhook/message` has always been HMAC-verified here.
 *
 * `/api/v1/webhooks/human_notify` had not. It sits in the auth middleware's
 * PUBLIC_ROUTES, and this hook only ever matched the exact string
 * "/webhook/message", so the route was reachable with no credential at all:
 * a POST carrying only a conversationId forced that conversation into human
 * takeover, alerted every operator on the project, and dispatched a real SMS.
 */
const HMAC_ROUTES = ["/webhook/message"];
const SHARED_SECRET_ROUTES = ["/api/v1/webhooks/human_notify"];

function pathOf(url: string): string {
  return url.split("?")[0];
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Length is compared first and non-constant-time on purpose: buffers of
  // different lengths make timingSafeEqual throw, and a length difference is
  // not the secret.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Rejects, or — while STRICT_WEBHOOK_AUTH is off — records, an unauthenticated
 * call to a shared-secret webhook route.
 *
 * Permissive is the default so that enabling this cannot take the live flow
 * offline the moment it deploys. The warning it emits is the migration signal:
 * once the log stops showing unauthenticated calls, the flow has been updated
 * and STRICT_WEBHOOK_AUTH can be turned on.
 */
function rejectOrWarn(request: FastifyRequest, reply: FastifyReply, reason: string): boolean {
  if (!config.STRICT_WEBHOOK_AUTH) {
    logger.warn(
      { url: pathOf(request.url), ip: request.ip, reason },
      "Unauthenticated webhook call allowed: STRICT_WEBHOOK_AUTH is off. This route is open"
    );
    return false;
  }
  logger.warn({ url: pathOf(request.url), ip: request.ip, reason }, "Rejected webhook call");
  reply.status(403).send({
    error: "Forbidden",
    message: "Invalid webhook signature",
  });
  return true;
}

/**
 * Fastify preValidation hook for webhook authentication.
 *
 * HMAC routes: x-signature is HMAC-SHA256 of the body under WEBHOOK_SECRET.
 * Shared-secret routes: x-webhook-secret carries WEBHOOK_SECRET directly, or
 * x-signature carries the same HMAC as above if the caller can compute one.
 *
 * With no WEBHOOK_SECRET configured there is nothing to verify against. HMAC
 * routes keep their long-standing skip; shared-secret routes fail closed under
 * strict mode rather than silently accepting everything.
 */
export async function webhookSignatureHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.method !== "POST") {
    return;
  }

  const path = pathOf(request.url);
  const isHmacRoute = HMAC_ROUTES.includes(path);
  const isSharedSecretRoute = SHARED_SECRET_ROUTES.includes(path);
  if (!isHmacRoute && !isSharedSecretRoute) {
    return;
  }

  if (!config.WEBHOOK_SECRET) {
    if (isSharedSecretRoute && config.STRICT_WEBHOOK_AUTH) {
      logger.error(
        { url: path },
        "STRICT_WEBHOOK_AUTH is on but WEBHOOK_SECRET is not configured; failing closed"
      );
      reply.status(503).send({
        error: "Service Unavailable",
        message: "Webhook authentication is not configured",
      });
      return;
    }
    return;
  }

  const signature = request.headers["x-signature"] as string | undefined;
  const sharedSecret = request.headers["x-webhook-secret"] as string | undefined;

  if (isSharedSecretRoute && !signature && !sharedSecret) {
    rejectOrWarn(request, reply, "missing x-webhook-secret and x-signature");
    return;
  }

  if (isSharedSecretRoute && sharedSecret) {
    if (!constantTimeEquals(sharedSecret, config.WEBHOOK_SECRET)) {
      rejectOrWarn(request, reply, "x-webhook-secret mismatch");
    }
    return;
  }

  if (!signature) {
    logger.warn({ url: path, ip: request.ip }, "Missing x-signature header");
    reply.status(403).send({
      error: "Forbidden",
      message: "Invalid webhook signature",
    });
    return;
  }

  const rawBody = JSON.stringify(request.body);
  const expectedSignature = crypto.createHmac("sha256", config.WEBHOOK_SECRET).update(rawBody).digest("hex");

  // Hex-decoding a malformed signature yields a short buffer rather than
  // throwing, so the length comparison below still decides the outcome.
  const sigBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expectedSignature, "hex");

  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    if (isSharedSecretRoute) {
      rejectOrWarn(request, reply, "x-signature mismatch");
      return;
    }
    logger.warn({ url: path, ip: request.ip }, "Invalid webhook signature");
    reply.status(403).send({
      error: "Forbidden",
      message: "Invalid webhook signature",
    });
    return;
  }

  logger.debug({ url: path }, "Webhook signature verified");
}
