import { pool } from "../adapters/postgres/PostgresAdapter";
import axios from "axios";
import { config } from "../config/env";

export interface PlaneCredentialInput {
  type?: string;
  secret: string;
}

export interface CreatePlaneIntegrationInput {
  workspaceSlug: string;
  planeProjectId: string;
  apiBaseUrl?: string;
  credential?: PlaneCredentialInput;
  apiKey?: string; // backwards compatibility fallback if passed
}

export interface UpdatePlaneIntegrationInput {
  workspaceSlug?: string;
  planeProjectId?: string;
  apiBaseUrl?: string;
  credential?: PlaneCredentialInput;
  apiKey?: string;
}

export interface SanitizedPlaneIntegration {
  id: number;
  projectId: number;
  projectName: string;
  orgId: string;
  workspaceSlug: string;
  planeProjectId: string;
  apiBaseUrl: string;
  credentialStatus: "configured" | "not_configured";
  connectionStatus: "CONNECTED" | "FAILED" | "DISABLED";
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  lastSuccessfulSyncAt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlaneTestResult {
  status: "CONNECTED" | "FAILED";
  workspace?: string;
  project?: {
    id: string;
    name: string;
    identifier?: string;
  };
  capabilities?: {
    read: boolean;
    create_issue: boolean;
    update_issue: boolean;
  };
  statesCount?: number;
  testedAt: string;
  errorCode?: string;
  message?: string;
}

export class PlaneAdminService {
  /**
   * Helper to map axios/network errors to sanitized, secret-free error codes.
   */
  private sanitizeError(err: any): { code: string; message: string } {
    if (err.code === "ECONNABORTED" || err.message?.toLowerCase().includes("timeout")) {
      return { code: "PLANE_TIMEOUT", message: "Request to Plane server timed out" };
    }
    if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
      return { code: "PLANE_SERVER_UNREACHABLE", message: "Cannot reach Plane server base URL" };
    }
    const httpStatus = err.response?.status;
    if (httpStatus === 401 || httpStatus === 403) {
      return { code: "PLANE_AUTH_FAILED", message: "Plane API authentication failed: Invalid or expired API Key" };
    }
    if (httpStatus === 404) {
      return { code: "PLANE_PROJECT_NOT_FOUND", message: "Plane Workspace or Project not found" };
    }
    return { code: "PLANE_UNKNOWN_ERROR", message: "Failed to communicate with Plane" };
  }

  /**
   * List all active Plane integrations (Sanitized).
   */
  async listPlaneIntegrations(orgId?: string, isSuperAdmin = false): Promise<SanitizedPlaneIntegration[]> {
    let query = `
      SELECT pwm.id, pwm.project_id, COALESCE(p.name, 'Unknown Project') AS project_name,
             pwm.org_id, pwm.workspace_slug, pwm.plane_project_id, pwm.plane_api_base_url,
             pwm.credential_ref, pwm.enabled, pwm.connection_status, pwm.last_tested_at,
             pwm.last_error_code, pwm.last_successful_sync_at, pwm.created_at, pwm.updated_at
      FROM plane_workspace_mappings pwm
      LEFT JOIN projects p ON p.id = pwm.project_id
      WHERE pwm.archived_at IS NULL
    `;
    const params: any[] = [];

    if (!isSuperAdmin && orgId) {
      params.push(orgId);
      query += ` AND pwm.org_id = $${params.length}`;
    }

    query += ` ORDER BY pwm.project_id ASC, pwm.id ASC`;

    const res = await pool.query(query, params);
    return res.rows.map((r: any) => ({
      id: r.id,
      projectId: r.project_id,
      projectName: r.project_name,
      orgId: r.org_id,
      workspaceSlug: r.workspace_slug,
      planeProjectId: r.plane_project_id,
      apiBaseUrl: r.plane_api_base_url,
      credentialStatus: r.credential_ref ? "configured" : "not_configured",
      connectionStatus: !r.enabled ? "DISABLED" : (r.connection_status || "CONNECTED"),
      lastTestedAt: r.last_tested_at,
      lastErrorCode: r.last_error_code,
      lastSuccessfulSyncAt: r.last_successful_sync_at,
      enabled: r.enabled,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Get single Plane integration mapping for a project (Sanitized).
   */
  async getProjectPlaneIntegration(
    projectId: number,
    orgId?: string,
    isSuperAdmin = false
  ): Promise<SanitizedPlaneIntegration | null> {
    let query = `
      SELECT pwm.id, pwm.project_id, COALESCE(p.name, 'Unknown Project') AS project_name,
             pwm.org_id, pwm.workspace_slug, pwm.plane_project_id, pwm.plane_api_base_url,
             pwm.credential_ref, pwm.enabled, pwm.connection_status, pwm.last_tested_at,
             pwm.last_error_code, pwm.last_successful_sync_at, pwm.created_at, pwm.updated_at
      FROM plane_workspace_mappings pwm
      LEFT JOIN projects p ON p.id = pwm.project_id
      WHERE pwm.project_id = $1 AND pwm.archived_at IS NULL
    `;
    const params: any[] = [projectId];

    if (!isSuperAdmin && orgId) {
      params.push(orgId);
      query += ` AND pwm.org_id = $${params.length}`;
    }

    query += ` LIMIT 1`;

    const res = await pool.query(query, params);
    if (!res.rows || res.rows.length === 0) return null;

    const r = res.rows[0];
    return {
      id: r.id,
      projectId: r.project_id,
      projectName: r.project_name,
      orgId: r.org_id,
      workspaceSlug: r.workspace_slug,
      planeProjectId: r.plane_project_id,
      apiBaseUrl: r.plane_api_base_url,
      credentialStatus: r.credential_ref ? "configured" : "not_configured",
      connectionStatus: !r.enabled ? "DISABLED" : (r.connection_status || "CONNECTED"),
      lastTestedAt: r.last_tested_at,
      lastErrorCode: r.last_error_code,
      lastSuccessfulSyncAt: r.last_successful_sync_at,
      enabled: r.enabled,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Create Plane Integration for a project.
   */
  async createProjectPlaneIntegration(
    projectId: number,
    input: CreatePlaneIntegrationInput,
    userOrgId: string,
    isSuperAdmin = false
  ): Promise<{ success: boolean; credentialStatus: "configured" }> {
    // 1. Resolve project and verify org ownership
    const projRes = await pool.query(
      "SELECT id, name, org_id FROM projects WHERE id = $1 LIMIT 1",
      [projectId]
    );
    if (!projRes.rows || projRes.rows.length === 0) {
      throw new Error(`Project ${projectId} not found`);
    }
    const project = projRes.rows[0];
    const projectOrgId = project.org_id || "org_default";

    if (!isSuperAdmin && userOrgId !== projectOrgId) {
      throw new Error(`Unauthorized: Project belongs to ${projectOrgId}`);
    }

    const secret = input.credential?.secret || input.apiKey;
    if (!secret || !secret.trim()) {
      throw new Error("Plane API Credential secret is required");
    }

    const apiBaseUrl = (input.apiBaseUrl || config.PLANE_API_URL || "https://projects.oneweb.tech").replace(/\/+$/, "");
    const workspaceSlug = input.workspaceSlug.trim();
    const planeProjectId = input.planeProjectId.trim();

    // 2. Check mapping uniqueness: Check if active enabled mapping exists
    const existing = await pool.query(
      `SELECT id FROM plane_workspace_mappings 
       WHERE project_id = $1 AND org_id = $2 AND enabled = TRUE AND archived_at IS NULL 
       LIMIT 1`,
      [projectId, projectOrgId]
    );
    if (existing.rows && existing.rows.length > 0) {
      const err: any = new Error(`An active Plane integration already exists for Project ${projectId}`);
      err.statusCode = 409;
      throw err;
    }

    // 3. Insert new mapping
    await pool.query(
      `INSERT INTO plane_workspace_mappings (
        project_id, org_id, workspace_slug, plane_project_id, plane_api_base_url,
        plane_api_key, credential_ref, enabled, connection_status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $6, TRUE, 'CONNECTED', NOW(), NOW())`,
      [projectId, projectOrgId, workspaceSlug, planeProjectId, apiBaseUrl, secret.trim()]
    );

    return { success: true, credentialStatus: "configured" };
  }

  /**
   * Update existing Plane Integration for a project.
   */
  async updateProjectPlaneIntegration(
    projectId: number,
    input: UpdatePlaneIntegrationInput,
    userOrgId: string,
    isSuperAdmin = false
  ): Promise<{ success: boolean; credentialStatus: "configured" }> {
    let checkQuery = `
      SELECT id, org_id, credential_ref FROM plane_workspace_mappings 
      WHERE project_id = $1 AND archived_at IS NULL
    `;
    const checkParams: any[] = [projectId];
    if (!isSuperAdmin && userOrgId) {
      checkParams.push(userOrgId);
      checkQuery += ` AND org_id = $2`;
    }
    checkQuery += ` LIMIT 1`;

    const existing = await pool.query(checkQuery, checkParams);
    if (!existing.rows || existing.rows.length === 0) {
      const err: any = new Error(`Plane integration mapping not found for Project ${projectId}`);
      err.statusCode = 404;
      throw err;
    }

    const mappingId = existing.rows[0].id;
    const secret = input.credential?.secret || input.apiKey;

    const updates: string[] = ["updated_at = NOW()"];
    const values: any[] = [mappingId];

    if (input.workspaceSlug) {
      values.push(input.workspaceSlug.trim());
      updates.push(`workspace_slug = $${values.length}`);
    }
    if (input.planeProjectId) {
      values.push(input.planeProjectId.trim());
      updates.push(`plane_project_id = $${values.length}`);
    }
    if (input.apiBaseUrl) {
      values.push(input.apiBaseUrl.trim().replace(/\/+$/, ""));
      updates.push(`plane_api_base_url = $${values.length}`);
    }
    if (secret && secret.trim()) {
      values.push(secret.trim());
      updates.push(`plane_api_key = $${values.length}`);
      updates.push(`credential_ref = $${values.length}`);
    }

    await pool.query(
      `UPDATE plane_workspace_mappings SET ${updates.join(", ")} WHERE id = $1`,
      values
    );

    return { success: true, credentialStatus: "configured" };
  }

  /**
   * Toggle enabled status of a project Plane integration.
   */
  async toggleProjectPlaneIntegrationStatus(
    projectId: number,
    enabled: boolean,
    userOrgId: string,
    isSuperAdmin = false
  ): Promise<{ success: boolean; enabled: boolean }> {
    let checkQuery = `
      SELECT id, org_id FROM plane_workspace_mappings 
      WHERE project_id = $1 AND archived_at IS NULL
    `;
    const checkParams: any[] = [projectId];
    if (!isSuperAdmin && userOrgId) {
      checkParams.push(userOrgId);
      checkQuery += ` AND org_id = $2`;
    }
    checkQuery += ` LIMIT 1`;

    const existing = await pool.query(checkQuery, checkParams);
    if (!existing.rows || existing.rows.length === 0) {
      const err: any = new Error(`Plane integration mapping not found for Project ${projectId}`);
      err.statusCode = 404;
      throw err;
    }

    const mappingId = existing.rows[0].id;
    const targetStatus = enabled ? "CONNECTED" : "DISABLED";

    await pool.query(
      `UPDATE plane_workspace_mappings 
       SET enabled = $2, connection_status = $3, updated_at = NOW() 
       WHERE id = $1`,
      [mappingId, enabled, targetStatus]
    );

    return { success: true, enabled };
  }

  /**
   * Archive (Soft-Delete) a project Plane integration.
   */
  async archiveProjectPlaneIntegration(
    projectId: number,
    userOrgId: string,
    isSuperAdmin = false
  ): Promise<{ success: boolean; archived: boolean }> {
    let checkQuery = `
      SELECT id FROM plane_workspace_mappings 
      WHERE project_id = $1 AND archived_at IS NULL
    `;
    const checkParams: any[] = [projectId];
    if (!isSuperAdmin && userOrgId) {
      checkParams.push(userOrgId);
      checkQuery += ` AND org_id = $2`;
    }
    checkQuery += ` LIMIT 1`;

    const existing = await pool.query(checkQuery, checkParams);
    if (!existing.rows || existing.rows.length === 0) {
      const err: any = new Error(`Plane integration mapping not found for Project ${projectId}`);
      err.statusCode = 404;
      throw err;
    }

    const mappingId = existing.rows[0].id;

    await pool.query(
      `UPDATE plane_workspace_mappings 
       SET enabled = FALSE, archived_at = NOW(), updated_at = NOW() 
       WHERE id = $1`,
      [mappingId]
    );

    return { success: true, archived: true };
  }

  /**
   * Non-destructive Deep Capability Test against Plane.
   */
  async testPlaneIntegration(params: {
    projectId?: number;
    workspaceSlug?: string;
    planeProjectId?: string;
    apiBaseUrl?: string;
    credential?: PlaneCredentialInput;
    apiKey?: string;
  }): Promise<PlaneTestResult> {
    let ws = params.workspaceSlug?.trim();
    let projId = params.planeProjectId?.trim();
    let apiBase = (params.apiBaseUrl || config.PLANE_API_URL || "https://projects.oneweb.tech").replace(/\/+$/, "");
    let secret = params.credential?.secret || params.apiKey;

    // If params not supplied in body, load from existing project mapping in DB
    if ((!ws || !projId || !secret) && params.projectId) {
      const existing = await pool.query(
        `SELECT workspace_slug, plane_project_id, plane_api_base_url, plane_api_key, credential_ref 
         FROM plane_workspace_mappings 
         WHERE project_id = $1 AND archived_at IS NULL 
         LIMIT 1`,
        [params.projectId]
      );
      if (existing.rows && existing.rows.length > 0) {
        const row = existing.rows[0];
        ws = ws || row.workspace_slug;
        projId = projId || row.plane_project_id;
        apiBase = apiBase || row.plane_api_base_url;
        secret = secret || row.plane_api_key || row.credential_ref;
      }
    }

    if (!ws || !projId || !secret) {
      return {
        status: "FAILED",
        errorCode: "PLANE_INVALID_CONFIG",
        message: "Missing workspace, project ID, or API key for test",
        testedAt: new Date().toISOString(),
      };
    }

    try {
      const headers = { "X-API-Key": secret };
      const projectUrl = `${apiBase}/api/v1/workspaces/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projId)}/`;
      const statesUrl = `${apiBase}/api/v1/workspaces/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projId)}/states/`;

      // 1. Fetch Project Details (Tests URL, Key, Workspace, and Project existence)
      const projectRes = await axios.get(projectUrl, { headers, timeout: 6000 });
      const projData = projectRes.data || {};

      // 2. Fetch States (Tests Read & State capabilities for work items)
      const statesRes = await axios.get(statesUrl, { headers, timeout: 6000 });
      const statesList = Array.isArray(statesRes.data)
        ? statesRes.data
        : Array.isArray(statesRes.data?.results)
          ? statesRes.data.results
          : [];

      // Update diagnostic records in DB if projectId was provided
      if (params.projectId) {
        await pool.query(
          `UPDATE plane_workspace_mappings 
           SET connection_status = 'CONNECTED', last_tested_at = NOW(), last_error_code = NULL, updated_at = NOW() 
           WHERE project_id = $1 AND archived_at IS NULL`,
          [params.projectId]
        );
      }

      return {
        status: "CONNECTED",
        workspace: ws,
        project: {
          id: String(projData.id || projId),
          name: String(projData.name || "Plane Project"),
          identifier: projData.identifier || undefined,
        },
        capabilities: {
          read: true,
          create_issue: statesList.length > 0,
          update_issue: statesList.length > 0,
        },
        statesCount: statesList.length,
        testedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      const sanitized = this.sanitizeError(err);

      if (params.projectId) {
        await pool.query(
          `UPDATE plane_workspace_mappings 
           SET connection_status = 'FAILED', last_tested_at = NOW(), last_error_code = $2, updated_at = NOW() 
           WHERE project_id = $1 AND archived_at IS NULL`,
          [params.projectId, sanitized.code]
        );
      }

      return {
        status: "FAILED",
        errorCode: sanitized.code,
        message: sanitized.message,
        testedAt: new Date().toISOString(),
      };
    }
  }
}
