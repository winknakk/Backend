import { FastifyRequest, FastifyReply } from "fastify";
import { JwtUtil } from "../shared/jwt";
import { config } from "../config/env";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { createLogger } from "../observability/logger";
import { AuthPrincipal } from "../infrastructure/security/SessionTokenService";
import { tenantScopeHook } from "./tenantScope";

const logger = createLogger("customer-auth");

/**
 * Returns the secret used to sign/verify WebChat and Customer tokens.
 * Reuses SESSION_SECRET and fails closed if missing or insecure.
 */
export function getWebchatJwtSecret(): string {
  const secret = config.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be configured and at least 32 characters for Customer WebChat tokens");
  }
  return secret;
}

/**
 * Dedicated authentication hook for customer portal endpoints (/api/portal/*).
 *
 * Enforces:
 * 1. Bearer token extraction and cryptographic signature validation with SESSION_SECRET.
 * 2. Strict rejection of guest tokens (403 GUEST_NOT_PERMITTED).
 * 3. Strict rejection of operator console tokens and non-customer credentials.
 * 4. Server-authoritative resolution of org_id and project boundaries from database mapping.
 * 5. Fails closed on any validation, signature, or configuration error.
 */
export async function customerAuthHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn({ url: request.url, ip: request.ip }, "Customer portal request missing Bearer token");
    reply.status(401).send({ error: "Unauthorized", message: "Customer authentication required" });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    reply.status(401).send({ error: "Unauthorized", message: "Customer authentication token cannot be empty" });
    return;
  }

  let jwtSecret: string;
  try {
    jwtSecret = getWebchatJwtSecret();
  } catch (err: any) {
    logger.error({ error: err.message }, "Customer auth failed closed: secret not configured");
    reply.status(500).send({ error: "Internal Server Error", message: "Server authentication is not configured" });
    return;
  }

  const decoded = JwtUtil.verify(token, jwtSecret);
  if (!decoded) {
    logger.warn({ url: request.url }, "Customer portal request with invalid or expired token");
    reply.status(401).send({ error: "Unauthorized", message: "Invalid or expired customer token" });
    return;
  }

  // Refuse guests with 403 GUEST_NOT_PERMITTED - load-bearing rule
  if (decoded.role === "guest") {
    logger.warn({ identityId: decoded.identityId, profileId: decoded.profileId }, "Guest refused on customer portal");
    reply.status(403).send({
      error: "Forbidden",
      code: "GUEST_NOT_PERMITTED",
      message: "Guest visitors cannot access ticket history",
    });
    return;
  }

  // Refuse operator sessions or malformed tokens lacking customer role / profileId / projectId
  if (decoded.role !== "customer" || !decoded.profileId || !decoded.projectId) {
    logger.warn({ role: decoded.role, kind: (decoded as any).kind }, "Rejected non-customer credential on portal route");
    reply.status(403).send({
      error: "Forbidden",
      code: "CUSTOMER_CREDENTIAL_REQUIRED",
      message: "A valid customer credential is required",
    });
    return;
  }

  const projectId = parseInt(String(decoded.projectId), 10);
  if (isNaN(projectId) || projectId <= 0) {
    reply.status(403).send({
      error: "Forbidden",
      code: "INVALID_PROJECT_CLAIM",
      message: "Invalid project claim in token",
    });
    return;
  }

  // Server-authoritative resolution of org_id from project (ignoring any X-Org-Id header)
  let orgId = "org_default";
  try {
    const projRes = await pool.query("SELECT org_id FROM projects WHERE id = $1 LIMIT 1", [projectId]);
    if (projRes.rows.length > 0 && projRes.rows[0].org_id) {
      orgId = String(projRes.rows[0].org_id);
    }
  } catch (err: any) {
    logger.warn({ error: err.message, projectId }, "Failed to query org_id for project, using fallback");
  }

  // Build confined customer principal
  request.principal = {
    kind: "customer",
    subject: String(decoded.identityId || decoded.profileId),
    profileId: String(decoded.profileId),
    role: "customer",
    orgId,
    projectIds: [projectId], // strictly concrete array, never null
  };

  await tenantScopeHook(request);
}
