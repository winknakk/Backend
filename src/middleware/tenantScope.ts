import { FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { AuthPrincipal } from "../infrastructure/security/SessionTokenService";
import { createLogger } from "../observability/logger";
import { createTenantContext } from "../domain/tenant/TenantContext";

const logger = createLogger("tenant-scope");

/**
 * The set of projects a request is allowed to touch.
 *
 * Derived exclusively from the authenticated principal. Nothing here is ever
 * read from a query parameter or a request header: `?projectId=` and
 * `x-project-id` previously *were* the authorization decision, which let any
 * caller read another organization's data by changing a number.
 */
export interface TenantScope {
  /** True for service callers and super_admin: every org, every project. */
  unrestricted: boolean;
  /** Organization the principal is confined to, or null when unrestricted. */
  orgId: string | null;
  /** Concrete project ids the principal may access; empty when it has none. */
  projectIds: number[];
}

declare module "fastify" {
  interface FastifyRequest {
    tenantScope?: TenantScope;
  }
}

const UNRESTRICTED: TenantScope = { unrestricted: true, orgId: null, projectIds: [] };

/** Short-lived cache so org-wide scope does not cost a query per request. */
const scopeCache = new Map<string, { scope: TenantScope; expiresAt: number }>();
const SCOPE_TTL_MS = 30_000;

export function clearTenantScopeCache(): void {
  scopeCache.clear();
}

async function projectIdsForOrg(orgId: string): Promise<number[]> {
  const res = await pool.query(`SELECT id FROM projects WHERE org_id = $1`, [orgId]);
  return res.rows.map((r: any) => Number(r.id)).filter((n: number) => Number.isInteger(n));
}

export async function resolveTenantScope(principal: AuthPrincipal): Promise<TenantScope> {
  // orgId null means "not confined to an organization" — service callers and
  // super_admin only, both of which are set server-side at login.
  if (principal.orgId === null && principal.projectIds === null) {
    return UNRESTRICTED;
  }

  // Explicit per-project grants (operator_project_access) come from the
  // principal itself, so there is no lookup to amortise and nothing to cache.
  //
  // Caching them was actively wrong: the key was kind:subject:orgId, which
  // omits the grants. Two tokens for the same operator carrying DIFFERENT
  // project sets collided, and the first one seen decided access for both -
  // so a re-issued token with a project grant removed kept the old, wider
  // scope until the entry expired.
  if (principal.projectIds !== null) {
    return {
      unrestricted: false,
      orgId: principal.orgId,
      projectIds: principal.projectIds,
    };
  }

  // Org-wide role: every project belonging to the principal's organization.
  // This one is a database lookup, and is what the cache exists for. Keyed by
  // organization, because that is the only input.
  const cacheKey = `org:${principal.orgId}`;
  const cached = scopeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.scope;
  }

  const scope: TenantScope = {
    unrestricted: false,
    orgId: principal.orgId,
    projectIds: await projectIdsForOrg(principal.orgId as string),
  };
  scopeCache.set(cacheKey, { scope, expiresAt: Date.now() + SCOPE_TTL_MS });
  return scope;
}

/**
 * Registered as a preHandler so it is guaranteed to run after every onRequest
 * hook — including authHook, which sets request.principal, and the tenant
 * plugin, which installs the base tenantContext.
 *
 * Resolving org-wide scope needs a query, which is why this cannot live in
 * TenantResolver.resolve() (synchronous). Requests without a principal
 * (public routes) get no scope, and anything requiring one refuses them.
 */
export async function tenantScopeHook(request: FastifyRequest): Promise<void> {
  if (!request.principal) return;

  const principal = request.principal;
  const scope = await resolveTenantScope(principal);
  request.tenantScope = scope;

  // Rebuild the tenant context from the principal rather than enriching
  // whatever the tenant plugin produced. The plugin's hook is installed
  // during boot, so whether it observes request.principal depends on hook
  // ordering; deriving the context here makes the result independent of that.
  const base = request.tenantContext;
  request.tenantContext = createTenantContext({
    // "org_all" is the sentinel the data layer reads as "every organization".
    orgId: principal.orgId || "org_all",
    projectId: scope.projectIds.length > 0 ? String(scope.projectIds[0]) : base?.projectId,
    source: principal.kind === "service" ? "api_key" : "jwt",
    isFallback: false,
    roles: [principal.role],
    permissions: scope.unrestricted ? ["*"] : ["read", "write"],
    correlationId: base?.correlationId,
    timestamp: base?.timestamp,
    allowedProjectIds: scope.unrestricted ? null : scope.projectIds,
  });
}

export interface ResolvedProjectFilter {
  /** null means "do not filter by project" — unrestricted callers only. */
  projectIds: number[] | null;
}

/**
 * Validates a caller-supplied projectId against the request's scope.
 *
 * Returns the project filter handlers should apply, or sends a 403/400 and
 * returns null. `all` is not rejected outright — it is *bounded*: it resolves
 * to the projects this principal may see, which for an unrestricted caller is
 * genuinely every project and for everyone else is their own grant list.
 */
export function resolveProjectFilter(
  request: FastifyRequest,
  reply: FastifyReply,
  requestedProjectId: string | number | undefined | null
): ResolvedProjectFilter | null {
  const scope = request.tenantScope;

  if (!scope) {
    reply.status(403).send({
      error: "Forbidden",
      message: "No tenant scope is associated with this request",
    });
    return null;
  }

  const raw = requestedProjectId === undefined || requestedProjectId === null ? "" : String(requestedProjectId).trim();
  const wantsAll = raw === "" || raw.toLowerCase() === "all";

  if (wantsAll) {
    if (scope.unrestricted) return { projectIds: null };
    if (scope.projectIds.length === 0) {
      reply.status(403).send({
        error: "Forbidden",
        message: "This account has no project access",
      });
      return null;
    }
    return { projectIds: scope.projectIds };
  }

  // Strict match rather than parseInt: parseInt("1;DROP TABLE") returns 1 and
  // would quietly authorize project 1 for a malformed request. Queries are
  // parameterized so this is not an injection path, but silently accepting
  // garbage hides client bugs and makes the audit log misleading.
  if (!/^[0-9]+$/.test(raw)) {
    reply.status(400).send({ error: "Bad Request", message: `Invalid projectId: ${raw}` });
    return null;
  }
  const requested = parseInt(raw, 10);
  if (!Number.isInteger(requested) || requested <= 0) {
    reply.status(400).send({ error: "Bad Request", message: `Invalid projectId: ${raw}` });
    return null;
  }

  if (scope.unrestricted || scope.projectIds.includes(requested)) {
    return { projectIds: [requested] };
  }

  // Deliberately 403 and not 404: the caller is authenticated and the project
  // may well exist, they simply may not see it. Returning 404 here would let
  // an authenticated operator enumerate which project ids are real.
  logger.warn(
    {
      principal: request.principal?.subject,
      orgId: scope.orgId,
      requestedProjectId: requested,
      allowed: scope.projectIds,
    },
    "Denied cross-project access attempt"
  );
  reply.status(403).send({
    error: "Forbidden",
    message: `Project ${requested} is not accessible to this account`,
  });
  return null;
}

/**
 * True when the request may access the given project. Use for row-level checks
 * where the project id comes from a database row rather than the caller.
 */
export function canAccessProject(request: FastifyRequest, projectId: string | number | null | undefined): boolean {
  const scope = request.tenantScope;
  if (!scope) return false;
  if (scope.unrestricted) return true;
  const id = parseInt(String(projectId), 10);
  if (!Number.isInteger(id)) return false;
  return scope.projectIds.includes(id);
}
