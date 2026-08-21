import { DatabaseAdapter } from "../adapters/types";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";

const logger = createLogger("PlaneProjectResolver");

export interface PlaneProjectConfig {
  workspaceSlug: string;
  planeProjectId: string;
  apiBaseUrl: string;
  credentialRef: string;
}

export class PlaneProjectResolver {
  private dbAdapter: DatabaseAdapter;

  constructor(dbAdapter: DatabaseAdapter) {
    this.dbAdapter = dbAdapter;
  }

  /**
   * Resolves Plane integration config for a given project_id and org_id.
   * Enforces strict isolation: WHERE project_id = $1 AND org_id = $2 AND enabled = TRUE.
   * NEVER falls back to org_id or org_default when project_id is unmapped or missing.
   */
  async resolveByProjectId(projectId: number, orgId: string): Promise<PlaneProjectConfig> {
    if (!projectId || typeof projectId !== "number") {
      throw new Error(`PLANE_MAPPING_NOT_FOUND: Invalid or missing project_id (${projectId})`);
    }

    const tenantOrgId = orgId && orgId.trim() ? orgId.trim() : "org_default";

    const res = await pool.query(
      `SELECT workspace_slug, plane_project_id, plane_api_base_url, credential_ref, enabled
       FROM plane_workspace_mappings
       WHERE project_id = $1 AND org_id = $2 AND enabled = TRUE AND archived_at IS NULL
       LIMIT 1;`,
      [projectId, tenantOrgId]
    );

    if (!res.rows || res.rows.length === 0) {
      logger.warn({ projectId, tenantOrgId }, "Plane project mapping not found or disabled");
      throw new Error(`PLANE_MAPPING_NOT_FOUND: No active Plane mapping configured for project_id ${projectId} under org ${tenantOrgId}`);
    }

    const row = res.rows[0];
    return {
      workspaceSlug: row.workspace_slug,
      planeProjectId: row.plane_project_id,
      apiBaseUrl: row.plane_api_base_url || config.PLANE_API_URL,
      credentialRef: row.credential_ref,
    };
  }

  /**
   * Resolves Plane integration config for an existing TicketX Ticket.
   * Uses ticket.project_id and ticket.org_id to resolve authoritative mapping.
   */
  async resolveByTicketId(ticketId: string): Promise<{ config: PlaneProjectConfig; ticket: any }> {
    const { ticket } = await this.dbAdapter.getTicketCompanyContext(ticketId);
    if (!ticket) {
      throw new Error(`TICKET_NOT_FOUND: Ticket ${ticketId} does not exist`);
    }

    const projectId = Number(ticket.project_id || ticket.projectId);
    const orgId = String(ticket.org_id || ticket.orgId || "org_default");

    if (!projectId || Number.isNaN(projectId)) {
      throw new Error(`PLANE_MAPPING_NOT_FOUND: Ticket ${ticketId} has no valid project_id assigned`);
    }

    const resolvedConfig = await this.resolveByProjectId(projectId, orgId);
    return { config: resolvedConfig, ticket };
  }
}
