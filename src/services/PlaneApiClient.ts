import axios, { AxiosInstance } from "axios";
import { PlaneProjectConfig } from "./PlaneProjectResolver";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";

const logger = createLogger("PlaneApiClient");

export interface PlaneWorkItemPayload {
  name: string;
  description_html: string;
  priority: string;
  external_source: "TicketX";
  external_id: string;
  target_date?: string;
}

export class PlaneApiClient {
  private httpClient: AxiosInstance;

  constructor(httpClient: AxiosInstance = axios) {
    this.httpClient = httpClient;
  }

  /**
   * Resolves plain-text API key securely inside backend from credentialRef.
   * Credentials NEVER cross to low-code flows or frontend.
   */
  private resolveApiKey(credentialRef: string): string {
    if (!credentialRef || credentialRef.trim() === "") {
      throw new Error("PLANE_CREDENTIAL_ERROR: Empty credentialRef provided");
    }

    const ref = credentialRef.trim();
    if (ref.startsWith("env:")) {
      const envVarName = ref.slice(4);
      const envVal = process.env[envVarName] || (config as any)[envVarName];
      if (!envVal) {
        throw new Error(`PLANE_CREDENTIAL_ERROR: Environment variable ${envVarName} is not set`);
      }
      return envVal;
    }

    // Direct secret key stored securely in backend mapping table
    return ref;
  }

  /**
   * Builds full base URL for a Plane project endpoint.
   * Example: https://projects.oneweb.tech/api/v1/workspaces/cs-team/projects/09aa9c0e-8448-426f-8128-306c3dcf9d78
   */
  public getProjectBaseUrl(projectConfig: PlaneProjectConfig): string {
    const apiBase = (projectConfig.apiBaseUrl || config.PLANE_API_URL || "https://projects.oneweb.tech").replace(/\/+$/, "");
    const ws = encodeURIComponent(projectConfig.workspaceSlug);
    const proj = encodeURIComponent(projectConfig.planeProjectId);
    return `${apiBase}/api/v1/workspaces/${ws}/projects/${proj}`;
  }

  private getHeaders(projectConfig: PlaneProjectConfig) {
    const apiKey = this.resolveApiKey(projectConfig.credentialRef);
    return {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    };
  }

  /**
   * Creates a Work Item in the target Plane Project.
   */
  async createWorkItem(projectConfig: PlaneProjectConfig, payload: PlaneWorkItemPayload): Promise<{ id: string }> {
    const url = `${this.getProjectBaseUrl(projectConfig)}/work-items/`;
    logger.info({ url, planeProjectId: projectConfig.planeProjectId }, "Creating work item in Plane project");

    const res = await this.httpClient.post(url, payload, {
      headers: this.getHeaders(projectConfig),
      timeout: 8000,
    });

    if (!res.data || !res.data.id) {
      throw new Error("Plane API creation failed: No ID returned in response payload");
    }

    return { id: String(res.data.id) };
  }

  /**
   * Updates an existing Work Item in Plane.
   */
  async patchWorkItem(projectConfig: PlaneProjectConfig, planeIssueId: string, payload: any): Promise<void> {
    const url = `${this.getProjectBaseUrl(projectConfig)}/work-items/${encodeURIComponent(planeIssueId)}/`;
    logger.info({ url, planeIssueId }, "Patching work item in Plane project");

    await this.httpClient.patch(url, payload, {
      headers: this.getHeaders(projectConfig),
      timeout: 8000,
    });
  }

  /**
   * Retrieves a Work Item from Plane by ID.
   */
  async getWorkItem(projectConfig: PlaneProjectConfig, planeIssueId: string): Promise<any> {
    const url = `${this.getProjectBaseUrl(projectConfig)}/work-items/${encodeURIComponent(planeIssueId)}/`;
    const res = await this.httpClient.get(url, {
      headers: this.getHeaders(projectConfig),
      timeout: 5000,
    });
    return res.data;
  }

  /**
   * Retrieves project state definitions from Plane.
   */
  async listStates(projectConfig: PlaneProjectConfig): Promise<any[]> {
    const url = `${this.getProjectBaseUrl(projectConfig)}/states/`;
    const res = await this.httpClient.get(url, {
      headers: this.getHeaders(projectConfig),
      timeout: 5000,
    });

    if (Array.isArray(res.data)) return res.data;
    if (Array.isArray(res.data?.results)) return res.data.results;
    return [];
  }
}
