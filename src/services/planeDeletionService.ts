import axios from "axios";
import { config } from "../config/env";
import { pool } from "../adapters/postgres/PostgresAdapter";

export interface PlaneDeletionResult {
  deleted: boolean;
  alreadyAbsent: boolean;
  planeIssueId: string;
}

export interface PlaneDeleteOptions {
  projectId?: number | string;
  orgId?: string;
  planeWorkspaceSlug?: string;
  planeProjectId?: string;
  apiBaseUrl?: string;
  apiKey?: string;
}

type PlaneDeleteHttpClient = Pick<typeof axios, "delete">;

export async function deletePlaneWorkItem(
  planeIssueId: string,
  httpClient: PlaneDeleteHttpClient = axios,
  options?: PlaneDeleteOptions
): Promise<PlaneDeletionResult> {
  if (!planeIssueId?.trim()) {
    throw new Error("Plane work-item ID is required");
  }

  let workspaceSlug = options?.planeWorkspaceSlug || config.PLANE_WORKSPACE_SLUG;
  let planeProjectId = options?.planeProjectId || config.PLANE_PROJECT_ID;
  let apiBaseUrl = options?.apiBaseUrl || config.PLANE_API_URL || "https://projects.oneweb.tech";
  let apiKey = options?.apiKey || config.PLANE_API_KEY;

  // Try to resolve from plane_workspace_mappings if projectId or orgId provided
  if (options?.projectId || options?.orgId || (!workspaceSlug && !planeProjectId)) {
    try {
      let query = "SELECT workspace_slug, plane_project_id, plane_api_base_url, credential_ref FROM plane_workspace_mappings WHERE enabled = TRUE";
      const params: any[] = [];
      if (options?.projectId && !Number.isNaN(Number(options.projectId))) {
        params.push(Number(options.projectId));
        query += ` AND project_id = $${params.length}`;
      } else if (options?.orgId) {
        params.push(options.orgId);
        query += ` AND org_id = $${params.length}`;
      }
      query += " LIMIT 1";

      const res = await pool.query(query, params);
      if (res.rows && res.rows.length > 0) {
        const row = res.rows[0];
        workspaceSlug = row.workspace_slug || workspaceSlug;
        planeProjectId = row.plane_project_id || planeProjectId;
        apiBaseUrl = row.plane_api_base_url || apiBaseUrl;
        const ref = row.credential_ref;
        if (ref) {
          apiKey = ref.startsWith("env:") ? (process.env[ref.slice(4)] || apiKey) : ref;
        }
      }
    } catch {
      // fallback to standard credentials
    }
  }

  if (
    !apiKey ||
    apiKey === "plane_mock_key" ||
    !planeProjectId ||
    planeProjectId === "proj_id" ||
    !workspaceSlug ||
    workspaceSlug === "ws_id"
  ) {
    throw new Error("Plane API credentials are not configured");
  }

  const cleanBaseUrl = apiBaseUrl.replace(/\/+$/, "");
  const url =
    `${cleanBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}` +
    `/projects/${encodeURIComponent(planeProjectId)}` +
    `/work-items/${encodeURIComponent(planeIssueId)}/`;

  try {
    await httpClient.delete(url, {
      headers: { "X-API-Key": apiKey },
      timeout: 10000,
    });
    return { deleted: true, alreadyAbsent: false, planeIssueId };
  } catch (error: any) {
    const isAbsent =
      error?.response?.status === 404 ||
      error?.response?.status === 410 ||
      (error?.response?.status === 403 &&
        typeof error?.response?.data?.detail === "string" &&
        (error.response.data.detail.toLowerCase().includes("permission") ||
         error.response.data.detail.toLowerCase().includes("not found")));

    if (isAbsent) {
      return { deleted: false, alreadyAbsent: true, planeIssueId };
    }
    throw error;
  }
}
