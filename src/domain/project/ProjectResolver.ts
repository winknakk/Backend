import crypto from "crypto";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { config } from "../../config/env";
import { createLogger } from "../../observability/logger";

const logger = createLogger("project-resolver");

/**
 * The single authority for resolving a customer-supplied project reference.
 *
 * There were two implementations. LineProjectOnboardingService redeemed
 * hashed join codes from project_join_codes with tenant scoping, expiry and
 * revocation. The Orchestrator had its own version that matched a raw string
 * against projects.name / projects.slug / projects.code with no organization
 * filter — and referenced two columns (`code`, `is_active`) that do not exist,
 * so it threw on every call.
 *
 * This module is the canonical mechanism. Both callers use it.
 *
 * Canonical project identity, from the live schema:
 *   projects.id       integer, primary key, NOT NULL   - the identity
 *   projects.org_id   varchar, NOT NULL                - the tenant
 *   projects.name     varchar, NOT NULL
 *   projects.slug     varchar, nullable (NULL for every row today)
 *   projects.status   varchar, nullable ('active', or NULL)
 * There is no `code` column and no `is_active` column. A project's redeemable
 * code lives in project_join_codes as a salted digest, never in plaintext.
 */

export interface ResolvedProject {
  projectId: number;
  orgId: string;
  projectName: string;
  companyName: string;
  joinCodeId?: number;
}

export type ProjectResolutionFailure =
  | "CODE_EMPTY"
  | "CODE_NOT_FOUND"
  | "CODE_EXPIRED_OR_REVOKED"
  | "CHANNEL_NOT_ENABLED"
  | "PROJECT_NOT_FOUND"
  | "CROSS_TENANT_DENIED";

export interface ProjectResolution {
  ok: boolean;
  project?: ResolvedProject;
  failure?: ProjectResolutionFailure;
  reason?: string;
}

/** Normalisation must match LineProjectOnboardingService exactly, or a code minted by one will not verify in the other. */
export function normalizeJoinCode(value: string): string {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export class ProjectResolver {
  private readonly codePepper: string;

  constructor(codePepper: string = config.PROJECT_JOIN_CODE_PEPPER || "ticketx-default-pepper") {
    this.codePepper = codePepper;
  }

  private digestCode(code: string): string {
    return crypto.createHmac("sha256", this.codePepper).update(normalizeJoinCode(code)).digest("hex");
  }

  /**
   * Redeems a join code.
   *
   * Fails closed: an unknown, expired, revoked or wrong-channel code resolves
   * to nothing rather than falling back to a default project. The code is
   * never compared in plaintext, and the project name is never accepted as a
   * substitute — a customer typing another tenant's project name must not
   * join it.
   */
  async resolveByJoinCode(
    rawCode: string,
    opts: { channel?: string; expectedOrgId?: string } = {}
  ): Promise<ProjectResolution> {
    const normalized = normalizeJoinCode(rawCode);
    if (!normalized) {
      return { ok: false, failure: "CODE_EMPTY", reason: "No join code supplied" };
    }

    const channel = (opts.channel || "line").toLowerCase();
    const digest = this.digestCode(normalized);

    const { rows } = await pool.query(
      `SELECT c.id AS code_id, c.project_id, c.org_id, c.status AS code_status, c.expires_at,
              p.name AS project_name,
              COALESCE(co.name, '-') AS company_name,
              EXISTS (
                SELECT 1 FROM project_channels pc
                 WHERE pc.project_id = p.id
                   AND LOWER(pc.channel_type) = $2
                   AND COALESCE(pc.is_enabled, TRUE)
                   AND COALESCE(pc.active, TRUE)
              ) AS channel_enabled
         FROM project_join_codes c
         JOIN projects p ON p.id = c.project_id AND p.org_id = c.org_id
         LEFT JOIN companies co ON co.id = p.company_id
        WHERE c.code_digest = $1
        LIMIT 1`,
      [digest, channel]
    );

    if (rows.length === 0) {
      // Deliberately the same failure for "no such code" as for a code that
      // exists elsewhere: a customer must not be able to probe which codes are
      // real.
      return { ok: false, failure: "CODE_NOT_FOUND", reason: "Join code not recognised" };
    }

    const row = rows[0];

    if (row.code_status !== "active" || (row.expires_at && new Date(row.expires_at) <= new Date())) {
      return { ok: false, failure: "CODE_EXPIRED_OR_REVOKED", reason: "Join code is no longer valid" };
    }

    if (!row.channel_enabled) {
      return {
        ok: false,
        failure: "CHANNEL_NOT_ENABLED",
        reason: `Project ${row.project_id} has no enabled '${channel}' channel`,
      };
    }

    if (opts.expectedOrgId && String(row.org_id) !== String(opts.expectedOrgId)) {
      logger.warn(
        { projectId: row.project_id, codeOrg: row.org_id, expectedOrgId: opts.expectedOrgId },
        "Refused cross-tenant join code redemption"
      );
      return { ok: false, failure: "CROSS_TENANT_DENIED", reason: "Join code belongs to another organization" };
    }

    return {
      ok: true,
      project: {
        projectId: Number(row.project_id),
        orgId: String(row.org_id),
        projectName: String(row.project_name),
        companyName: String(row.company_name),
        joinCodeId: Number(row.code_id),
      },
    };
  }

  /**
   * Resolves a project by its numeric id, optionally constrained to an
   * organization. Used to validate a project reference that did not come from
   * a join code.
   *
   * A project id from another organization returns CROSS_TENANT_DENIED, not
   * the project — this is the check the Orchestrator's version lacked
   * entirely.
   */
  async resolveById(projectId: number | string, expectedOrgId?: string): Promise<ProjectResolution> {
    // Strict match, not parseInt: parseInt("1; DROP TABLE projects") returns 1
    // and would quietly resolve project 1 for a malformed reference. Queries
    // are parameterized so this is not an injection path, but silently
    // accepting garbage hides caller bugs and misleads the audit log.
    const raw = String(projectId).trim();
    if (!/^[0-9]+$/.test(raw)) {
      return { ok: false, failure: "PROJECT_NOT_FOUND", reason: `Invalid project id '${projectId}'` };
    }
    const id = parseInt(raw, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, failure: "PROJECT_NOT_FOUND", reason: `Invalid project id '${projectId}'` };
    }

    const { rows } = await pool.query(
      `SELECT p.id, p.org_id, p.name AS project_name, p.status,
              COALESCE(co.name, '-') AS company_name
         FROM projects p
         LEFT JOIN companies co ON co.id = p.company_id
        WHERE p.id = $1 AND p.deleted_at IS NULL
        LIMIT 1`,
      [id]
    );

    if (rows.length === 0) {
      return { ok: false, failure: "PROJECT_NOT_FOUND", reason: `Project ${id} does not exist` };
    }

    const row = rows[0];

    if (expectedOrgId && String(row.org_id) !== String(expectedOrgId)) {
      logger.warn(
        { projectId: id, projectOrg: row.org_id, expectedOrgId },
        "Refused cross-tenant project resolution"
      );
      return { ok: false, failure: "CROSS_TENANT_DENIED", reason: `Project ${id} belongs to another organization` };
    }

    return {
      ok: true,
      project: {
        projectId: Number(row.id),
        orgId: String(row.org_id),
        projectName: String(row.project_name),
        companyName: String(row.company_name),
      },
    };
  }
}

export const projectResolver = new ProjectResolver();
