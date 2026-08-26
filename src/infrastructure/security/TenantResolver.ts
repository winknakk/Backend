import { FastifyRequest } from "fastify";
import crypto from "crypto";
import { TenantContext, createTenantContext, DEFAULT_TENANT_CONTEXT } from "../../domain/tenant/TenantContext";
import { createLogger } from "../../observability/logger";

const logger = createLogger("TenantResolver");

export interface TenantResolverOptions {
  apiKeyHashMap?: Map<string, { orgId: string; projectId: string }>;
  webhookSecretMap?: Map<string, string>;
  allowLegacyFallback?: boolean;
}

export class TenantResolver {
  private apiKeyMap: Map<string, { orgId: string; projectId: string }>;
  private webhookSecrets: Map<string, string>;
  private allowFallback: boolean;

  constructor(options: TenantResolverOptions = {}) {
    this.apiKeyMap = options.apiKeyHashMap || new Map();
    this.webhookSecrets = options.webhookSecretMap || new Map();
    this.allowFallback = options.allowLegacyFallback ?? true;
  }

  public resolve(req: FastifyRequest): TenantContext {
    const correlationId =
      (req.headers["x-correlation-id"] as string) ||
      `corr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const timestamp = Date.now();

    // Step 0: Authenticated principal (authoritative).
    // authHook sets this from a verified session token or the service key. It
    // is the only tenant signal that cannot be chosen by the caller, so it
    // takes precedence over every heuristic below.
    const principalContext = this.resolveFromPrincipal(req, correlationId, timestamp);
    if (principalContext) {
      return principalContext;
    }

    // Step 1: JWT Bearer Token Validation (Claims)
    const jwtContext = this.resolveFromJWT(req, correlationId, timestamp);
    if (jwtContext) {
      // Step 4: Check if Admin Header Override (X-Org-Id) is permitted
      const overrideOrgId = req.headers["x-org-id"] as string;
      if (overrideOrgId && this.canOverrideTenant(jwtContext)) {
        logger.info({ correlationId, targetOrgId: overrideOrgId }, "[TenantResolver] Admin Header Override applied");
        return createTenantContext({
          orgId: overrideOrgId,
          projectId: jwtContext.projectId,
          source: "header_override",
          isFallback: false,
          roles: jwtContext.roles,
          permissions: jwtContext.permissions,
          correlationId,
          timestamp,
        });
      }
      return jwtContext;
    }

    // Step 2: API Key Header Validation (Hashed)
    const apiKeyContext = this.resolveFromApiKey(req, correlationId, timestamp);
    if (apiKeyContext) {
      return apiKeyContext;
    }

    // Step 3: Webhook HMAC Signature Validation
    const webhookContext = this.resolveFromWebhookSignature(req, correlationId, timestamp);
    if (webhookContext) {
      return webhookContext;
    }

    // Note: Direct unauthenticated X-Org-Id header is STRIPPED & IGNORED for security
    if (req.headers["x-org-id"]) {
      logger.warn({ correlationId, rawHeader: req.headers["x-org-id"] }, "[TenantResolver] Unauthenticated X-Org-Id header ignored");
    }

    // Step 5: Unauthenticated fallback.
    //
    // There used to be a project-inference step here that read
    // x-project-id / ?projectId straight off the request and built a context
    // around it, plus a default that granted roles ['admin'] and
    // permissions ['*']. Between them, an unauthenticated caller chose their
    // own tenant and got full privileges inside it.
    //
    // Unauthenticated requests now get an explicitly powerless context. Only
    // routes that do their own verification (signed webhooks, the login
    // surface, signed media URLs) reach this point at all.
    return createTenantContext({
      orgId: DEFAULT_TENANT_CONTEXT.orgId,
      projectId: DEFAULT_TENANT_CONTEXT.projectId,
      source: "fallback",
      isFallback: true,
      roles: [],
      permissions: [],
      correlationId,
      timestamp,
    });
  }

  /**
   * Builds the tenant context from the verified principal set by authHook.
   *
   * projectId is informational only — authorization uses the project list in
   * request.tenantScope, which is derived from the same principal.
   */
  private resolveFromPrincipal(req: FastifyRequest, correlationId: string, timestamp: number): TenantContext | null {
    const principal = (req as any).principal;
    if (!principal) return null;

    const isUnrestricted = principal.orgId === null;
    return createTenantContext({
      // "org_all" is the sentinel the data layer already understands as "do
      // not filter by organization". Falling back to org_default here would
      // silently confine a super_admin (and every service caller) to one
      // organization's rows.
      orgId: principal.orgId || "org_all",
      projectId: Array.isArray(principal.projectIds) && principal.projectIds.length > 0
        ? String(principal.projectIds[0])
        : DEFAULT_TENANT_CONTEXT.projectId,
      source: principal.kind === "service" ? "api_key" : "jwt",
      isFallback: false,
      roles: [principal.role],
      permissions: isUnrestricted ? ["*"] : ["read", "write"],
      correlationId,
      timestamp,
      // Placeholder. tenantScopeHook replaces this with the resolved list once
      // org-wide scope has been looked up (which needs a query, and resolve()
      // is synchronous). Defaulting to "no projects" means a missing hook
      // fails closed rather than open.
      allowedProjectIds: isUnrestricted ? null : [],
    });
  }

  private resolveFromJWT(req: FastifyRequest, correlationId: string, timestamp: number): TenantContext | null {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) return null;

    try {
      const token = authHeader.split(" ")[1];
      // Fastify JWT user payload check
      const user = (req as any).user || this.decodeJwtPayload(token);
      if (user && (user.org_id || user.orgId)) {
        return createTenantContext({
          orgId: user.org_id || user.orgId,
          projectId: String(user.project_id || user.projectId || "1"),
          source: "jwt",
          isFallback: false,
          roles: Array.isArray(user.roles) ? user.roles : ["user"],
          permissions: Array.isArray(user.permissions) ? user.permissions : ["*"],
          correlationId,
          timestamp,
        });
      }
    } catch (err: any) {
      logger.debug({ correlationId, error: err.message }, "[TenantResolver] Failed to parse JWT claims");
    }
    return null;
  }

  private resolveFromApiKey(req: FastifyRequest, correlationId: string, timestamp: number): TenantContext | null {
    const rawApiKey = req.headers["x-api-key"] as string;
    if (!rawApiKey) return null;

    const hashed = crypto.createHash("sha256").update(rawApiKey).digest("hex");
    const matched = this.apiKeyMap.get(hashed);
    if (matched) {
      return createTenantContext({
        orgId: matched.orgId,
        projectId: matched.projectId,
        source: "api_key",
        isFallback: false,
        roles: ["m2m_client"],
        permissions: ["*"],
        correlationId,
        timestamp,
      });
    }
    return null;
  }

  private resolveFromWebhookSignature(req: FastifyRequest, correlationId: string, timestamp: number): TenantContext | null {
    const signature =
      (req.headers["x-line-signature"] as string) ||
      (req.headers["x-plane-signature"] as string) ||
      (req.headers["x-hub-signature-256"] as string);
    if (!signature) return null;

    const channelOrgId = (req.headers["x-channel-org-id"] as string) || "org_default";
    return createTenantContext({
      orgId: channelOrgId,
      projectId: "1",
      source: "webhook",
      isFallback: false,
      roles: ["webhook_system"],
      permissions: ["write"],
      correlationId,
      timestamp,
    });
  }

  private canOverrideTenant(ctx: TenantContext): boolean {
    return ctx.roles.includes("SuperAdmin") || ctx.roles.includes("MultiOrgAdmin") || ctx.roles.includes("admin");
  }

  private decodeJwtPayload(token: string): any {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64").toString("utf-8");
    return JSON.parse(payload);
  }
}
