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

/**
 * Routes reached via a WebSocket upgrade. Browsers cannot set headers on a
 * WebSocket handshake, so these accept the credential as a `token` query
 * parameter in addition to the Authorization header.
 */
const WEBSOCKET_ROUTES = ["/api/admin/socket"];

function isWebSocketRoute(url: string): boolean {
  const path = url.split("?")[0];
  return WEBSOCKET_ROUTES.includes(path);
}

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
 * Resolves a bearer credential to a principal, or null.
 *
 * Single implementation shared by the HTTP hook and the WebSocket handshake,
 * so the two transports cannot drift apart on what counts as authenticated.
 */
export function authenticateToken(token: string): AuthPrincipal | null {
  const candidate = (token || "").trim();
  if (!candidate) return null;

  if (sessionTokenService) {
    const principal = sessionTokenService.verify(candidate);
    if (principal) return principal;
  }

  if (config.API_KEY && constantTimeEquals(candidate, config.API_KEY)) {
    return SERVICE_PRINCIPAL;
  }

  return null;
}

/** True when the server has no way to authenticate anyone at all. */
export function isAuthConfigured(): boolean {
  return Boolean(config.API_KEY || sessionTokenService);
}

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
  let token = "";

  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  } else if (isWebSocketRoute(request.url)) {
    token = String((request.query as any)?.token || "").trim();
  }

  if (!token) {
    logger.warn({ url: request.url, ip: request.ip }, "Missing or malformed credential");
    reply.status(401).send({ error: "Unauthorized", message: "Authentication required" });
    return;
  }

  const principal = authenticateToken(token);
  if (principal) {
    request.principal = principal;
    return;
  }

  logger.warn({ url: request.url, ip: request.ip }, "Rejected request with invalid credential");
  reply.status(401).send({ error: "Unauthorized", message: "Invalid or expired credential" });
}
