import { FastifyRequest, FastifyReply } from "fastify";
import { timingSafeEqual } from "crypto";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";
import { AuthPrincipal, SessionTokenService } from "../infrastructure/security/SessionTokenService";

const logger = createLogger("auth");

declare module "fastify" {
  interface FastifyRequest {
    /** Set by authHook for every authenticated request. */
    principal?: AuthPrincipal;
  }
}

/**
 * Routes that are intentionally reachable without an operator session.
 *
 * Each entry is either genuinely public (health), or carries its own
 * independent authentication:
 *   - /webhook/message and /api/v1/webhooks/* are HMAC-signature verified
 *     (webhookSignatureHook / verifyLineSignature)
 *   - /api/v1/auth/* is the login surface itself
 *   - /api/v1/media/* uses signed, expiring media URLs
 *
 * /api/v1/internal/* is deliberately NOT here. It was previously exempt,
 * which made every internal endpoint reachable with no credential at all.
 */
const PUBLIC_ROUTES = [
  "/health",
  "/webhook/message",
  "/api/v1/auth/",
  "/api/v1/webchat",
  "/api/v1/webhooks",
  "/api/v1/media/",
];

function isPublicRoute(url: string): boolean {
  const path = url.split("?")[0];
  return PUBLIC_ROUTES.some((route) => (route.endsWith("/") ? path.startsWith(route) : path === route || path.startsWith(`${route}/`)));
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

let sessionTokenService: SessionTokenService | null = null;
if (config.SESSION_SECRET) {
  sessionTokenService = new SessionTokenService(config.SESSION_SECRET, config.SESSION_TTL_HOURS);
}

export function getSessionTokenService(): SessionTokenService | null {
  return sessionTokenService;
}

/**
 * Machine-to-machine principal for callers presenting the shared service key.
 * Unrestricted by design; the key is only held by trusted backend components.
 */
const SERVICE_PRINCIPAL: AuthPrincipal = {
  kind: "service",
  subject: "service",
  role: "service",
  orgId: null,
  projectIds: null,
};

/**
 * Fastify onRequest hook enforcing authentication.
 *
 * Accepts either a signed operator session token (admin UI) or the shared
 * API_KEY (internal service callers). Fails closed in every environment when
 * neither credential mechanism is configured — a missing API_KEY previously
 * disabled authentication entirely outside production.
 */
export async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isPublicRoute(request.url)) {
    return;
  }

  if (!config.API_KEY && !sessionTokenService) {
    logger.error(
      { url: request.url },
      "SECURITY: neither API_KEY nor SESSION_SECRET is configured. Refusing all authenticated requests."
    );
    reply.status(503).send({
      error: "Service Unavailable",
      message: "Server authentication is not configured",
    });
    return;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn({ url: request.url, ip: request.ip }, "Missing or malformed Authorization header");
    reply.status(401).send({ error: "Unauthorized", message: "Authentication required" });
    return;
  }

  const token = authHeader.slice(7).trim();

  if (sessionTokenService) {
    const principal = sessionTokenService.verify(token);
    if (principal) {
      request.principal = principal;
      return;
    }
  }

  if (config.API_KEY && constantTimeEquals(token, config.API_KEY)) {
    request.principal = SERVICE_PRINCIPAL;
    return;
  }

  logger.warn({ url: request.url, ip: request.ip }, "Rejected request with invalid credential");
  reply.status(401).send({ error: "Unauthorized", message: "Invalid or expired credential" });
}
