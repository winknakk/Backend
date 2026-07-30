import axios from "axios";
import { config } from "../config/env";

export interface PlaneDeletionResult {
  deleted: boolean;
  alreadyAbsent: boolean;
  planeIssueId: string;
}

type PlaneDeleteHttpClient = Pick<typeof axios, "delete">;

function assertPlaneDeleteConfigured(): void {
  if (
    !config.PLANE_API_KEY ||
    config.PLANE_API_KEY === "plane_mock_key" ||
    !config.PLANE_PROJECT_ID ||
    config.PLANE_PROJECT_ID === "proj_id" ||
    !config.PLANE_WORKSPACE_SLUG ||
    config.PLANE_WORKSPACE_SLUG === "ws_id"
  ) {
    throw new Error("Plane API credentials are not configured");
  }
}

export async function deletePlaneWorkItem(
  planeIssueId: string,
  httpClient: PlaneDeleteHttpClient = axios
): Promise<PlaneDeletionResult> {
  if (!planeIssueId?.trim()) {
    throw new Error("Plane work-item ID is required");
  }

  assertPlaneDeleteConfigured();
  const url =
    `${config.PLANE_API_URL}/api/v1/workspaces/${encodeURIComponent(config.PLANE_WORKSPACE_SLUG)}` +
    `/projects/${encodeURIComponent(config.PLANE_PROJECT_ID)}` +
    `/work-items/${encodeURIComponent(planeIssueId)}/`;

  try {
    await httpClient.delete(url, {
      headers: { "X-API-Key": config.PLANE_API_KEY },
      timeout: 5000,
    });
    return { deleted: true, alreadyAbsent: false, planeIssueId };
  } catch (error: any) {
    if (error?.response?.status === 404 || error?.response?.status === 410) {
      return { deleted: false, alreadyAbsent: true, planeIssueId };
    }
    throw error;
  }
}
