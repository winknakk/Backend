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
 *   - /webhook/message is HMAC-signature verified (webhookSignatureHook)
 *   - /api/v1/webhooks/line is LINE-signature verified (verifyLineSignature)
 *   - /api/v1/webhooks/plane is verified against PLANE_WEBHOOK_SECRET
 *   - /api/v1/webhooks/human_notify is verified against WEBHOOK_SECRET, but
 *     only ENFORCED when STRICT_WEBHOOK_AUTH is set. Until then it is open:
 *     this comment previously claimed the whole /api/v1/webhooks/* prefix was
 *     HMAC-verified while webhookSignatureHook matched only "/webhook/message",
 *     so human_notify accepted anonymous requests for as long as it existed.
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
 * Internal endpoints the admin console legitimately calls with an operator
 * session. Everything else under /api/v1/internal/* is service-only.
 *
 * These are an acknowledged exception, not a design: they are operator
 * actions that happen to live under the internal prefix. The proper fix is to
 * move them to /api/admin/*, which is a frontend change tracked for Phase 12.
 * Until then they accept an operator principal AND remain subject to the
 * tenant scope enforced by tenantScopeHook, so a human credential still
 * cannot reach another tenant's data through them.
 */
const OPERATOR_PERMITTED_INTERNAL_ROUTES: RegExp[] = [
  /^\/api\/v1\/internal\/projects\/[^/]+\/git-repositories(\/[^/]+)?$/,
  /^\/api\/v1\/internal\/projects\/[^/]+\/git-sync-logs$/,
  /^\/api\/v1\/internal\/tickets\/close$/,
  /^\/api\/v1\/internal\/tickets\/[^/]+\/restore$/,
];

function isInternalRoute(url: string): boolean {
  return url.split("?")[0].startsWith("/api/v1/internal/");
}

function isOperatorPermittedInternalRoute(url: string): boolean {
  const path = url.split("?")[0];
  return OPERATOR_PERMITTED_INTERNAL_ROUTES.some((re) => re.test(path));
}

/**
 * Fastify onRequest hook restricting /api/v1/internal/* to service callers.
 *
 * Authenticating as a human operator - even a super_admin - does not confer
 * machine-to-machine access. A separate service identity is required, so a
 * stolen or misused console session cannot drive the automation surface.
 *
 * Must run after authHook.
 */
export async function internalApiGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isInternalRoute(request.url)) return;

  const principal = request.principal;
  if (!principal) {
    // authHook already refuses these; this is defence in depth.
    reply.status(401).send({ error: "Unauthorized", message: "Authentication required" });
    return;
  }

  if (principal.kind === "service") return;
  if (isOperatorPermittedInternalRoute(request.url)) return;

  logger.warn(
    { url: request.url, principal: principal.subject, role: principal.role },
    "Operator credential refused on a service-only internal endpoint"
  );
  reply.status(403).send({
    error: "Forbidden",
    code: "SERVICE_CREDENTIAL_REQUIRED",
    message: "This endpoint requires a service credential",
  });
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
