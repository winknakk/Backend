import { pool } from "../../adapters/postgres/PostgresAdapter";
import { AuthPrincipal } from "./SessionTokenService";
import { createLogger } from "../../observability/logger";

const logger = createLogger("principal-resolver");

/** Roles permitted to hold an admin/operator session. */
const OPERATOR_ROLES = new Set(["super_admin", "admin", "manager", "agent", "employee"]);

/** Roles that see every organization. */
const GLOBAL_ROLES = new Set(["super_admin"]);

/** Roles that see every project within their own organization. */
const ORG_WIDE_ROLES = new Set(["admin", "manager"]);

export class OperatorAuthorizationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

/**
 * Builds the authoritative tenant scope for a signed-in operator.
 *
 * This is the only place project and organization scope is derived. Scope is
 * never taken from a request parameter or header — see the tenant guard in
 * src/middleware/tenantScope.ts.
 */
export class OperatorPrincipalResolver {
  /**
   * Resolves the organization an operator belongs to.
   *
   * `user_roles` is the authority (it is the seeded email -> org mapping).
   * There is deliberately no default: an operator whose organization cannot
   * be established is refused rather than silently placed in org_default,
   * which would grant them another tenant's data.
   */
  private async resolveOrgId(email: string, role: string): Promise<string | null> {
    if (GLOBAL_ROLES.has(role)) return null;

    const res = await pool.query(
      `SELECT org_id FROM user_roles
        WHERE LOWER(user_email) = LOWER($1) AND status = 'active'
        LIMIT 1`,
      [email]
    );
    if (res.rows.length > 0 && res.rows[0].org_id) {
      return String(res.rows[0].org_id);
    }

    // Fall back to the organization owning the operator's projects. Only
    // accepted when it is unambiguous.
    const viaProjects = await pool.query(
      `SELECT DISTINCT p.org_id
         FROM operator_project_access opa
         JOIN projects p ON p.id = opa.project_id
         JOIN operators o ON o.id = opa.operator_id
        WHERE LOWER(o.email) = LOWER($1) AND p.org_id IS NOT NULL`,
      [email]
    );
    if (viaProjects.rows.length === 1) {
      return String(viaProjects.rows[0].org_id);
    }

    return null;
  }

  /**
   * Projects the operator may access.
   * Returns null for org-wide and global roles (meaning "all in scope").
   */
  private async resolveProjectIds(operatorId: string, role: string): Promise<number[] | null> {
    if (GLOBAL_ROLES.has(role) || ORG_WIDE_ROLES.has(role)) return null;

    const res = await pool.query(
      `SELECT project_id FROM operator_project_access WHERE operator_id = $1`,
      [operatorId]
    );
    return res.rows.map((r: any) => Number(r.project_id)).filter((n: number) => Number.isInteger(n));
  }

  /**
   * Builds a principal for an operator that has already been authenticated.
   * Throws OperatorAuthorizationError when the account may not hold a session.
   */
  async buildPrincipal(operator: {
    id: string;
    email: string;
    role: string;
    isActive: boolean;
  }): Promise<AuthPrincipal> {
    const role = String(operator.role || "").toLowerCase();

    if (!operator.isActive) {
      throw new OperatorAuthorizationError("Account is disabled", "ACCOUNT_DISABLED");
    }
    if (!OPERATOR_ROLES.has(role)) {
      throw new OperatorAuthorizationError(
        `Role '${role}' may not access the operator console`,
        "ROLE_NOT_PERMITTED"
      );
    }

    const orgId = await this.resolveOrgId(operator.email, role);
    if (orgId === null && !GLOBAL_ROLES.has(role)) {
      logger.warn({ email: operator.email, role }, "Refused session: organization could not be resolved");
      throw new OperatorAuthorizationError(
        "No organization is associated with this account",
        "ORG_UNRESOLVED"
      );
    }

    const projectIds = await this.resolveProjectIds(operator.id, role);

    return {
      kind: "operator",
      subject: String(operator.id),
      email: operator.email,
      role,
      orgId,
      projectIds,
    };
  }

  /** Looks up an active operator by email, including the stored password hash. */
  async findOperatorByEmail(email: string): Promise<{
    id: string;
    email: string;
    role: string;
    isActive: boolean;
    passwordHash: string | null;
  } | null> {
    const res = await pool.query(
      `SELECT id, email, role, is_active, password_hash
         FROM operators
        WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL
        LIMIT 1`,
      [email]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: String(row.id),
      email: String(row.email),
      role: String(row.role || ""),
      isActive: row.is_active !== false,
      passwordHash: row.password_hash || null,
    };
  }
}
