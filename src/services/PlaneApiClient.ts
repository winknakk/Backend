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

export interface PlaneWorkItemAttachment {
  name: string;
  type: string;
  size: number;
  content: Buffer;
  externalId?: string;
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
    const url = `${this.getProjectBaseUrl(projectConfig)}/issues/`;
    logger.info({ url, planeProjectId: projectConfig.planeProjectId }, "Creating work item in Plane project");

    try {
      const res = await this.httpClient.post(url, payload, {
        headers: this.getHeaders(projectConfig),
        timeout: 20000,
      });

      if (!res.data || !res.data.id) {
        throw new Error("Plane API creation failed: No ID returned in response payload");
      }

      return { id: String(res.data.id) };
    } catch (err: any) {
      if (err.response?.status === 409) {
        logger.info({ external_id: payload.external_id }, "Plane returned 409 Conflict: issue already created");
        return { id: String(payload.external_id) };
      }
      throw err;
    }
  }

  /**
   * Updates an existing Work Item in Plane.
   */
  async patchWorkItem(projectConfig: PlaneProjectConfig, planeIssueId: string, payload: any): Promise<void> {
    const url = `${this.getProjectBaseUrl(projectConfig)}/issues/${encodeURIComponent(planeIssueId)}/`;
    logger.info({ url, planeIssueId }, "Patching work item in Plane project");

    await this.httpClient.patch(url, payload, {
      headers: this.getHeaders(projectConfig),
      timeout: 20000,
    });
  }

  /**
   * Retrieves a Work Item from Plane by ID.
   */
  async getWorkItem(projectConfig: PlaneProjectConfig, planeIssueId: string): Promise<any> {
    const url = `${this.getProjectBaseUrl(projectConfig)}/issues/${encodeURIComponent(planeIssueId)}/`;
    const res = await this.httpClient.get(url, {
      headers: this.getHeaders(projectConfig),
      timeout: 20000,
    });
    return res.data;
  }

  /**
   * Copies customer evidence into Plane-owned storage. This deliberately does
   * not expose TicketX's short-lived signed media URLs in the work item.
   */
  async uploadWorkItemAttachment(
    projectConfig: PlaneProjectConfig,
    workItemId: string,
    attachment: PlaneWorkItemAttachment
  ): Promise<{ assetUrl?: string; attachmentId: string }> {
    const projectBase = this.getProjectBaseUrl(projectConfig);
    const encodedId = encodeURIComponent(workItemId);
    const primaryPath = `${projectBase}/issues/${encodedId}/issue-attachments/`;
    const fallbackPath = `${projectBase}/work-items/${encodedId}/attachments/`;

    let registration: any;
    let usedEndpoint = primaryPath;

    try {
      registration = await this.httpClient.post(
        primaryPath,
        {
          name: attachment.name,
          type: attachment.type,
          size: attachment.size,
          external_id: attachment.externalId,
          external_source: "TicketX",
        },
        { headers: this.getHeaders(projectConfig), timeout: 20000 }
      );
    } catch (err: any) {
      if (err.response?.status === 429) {
        logger.warn({ workItemId }, "Plane attachment registration hit 429 rate limit, retrying in 2 seconds...");
        await new Promise((r) => setTimeout(r, 2000));
        registration = await this.httpClient.post(
          primaryPath,
          {
            name: attachment.name,
            type: attachment.type,
            size: attachment.size,
            external_id: attachment.externalId,
            external_source: "TicketX",
          },
          { headers: this.getHeaders(projectConfig), timeout: 20000 }
        );
      } else if (err.response?.status === 404) {
        logger.info({ workItemId }, "issue-attachments returned 404, falling back to work-items/attachments");
        usedEndpoint = fallbackPath;
        registration = await this.httpClient.post(
          fallbackPath,
          {
            name: attachment.name,
            type: attachment.type,
            size: attachment.size,
            external_id: attachment.externalId,
            external_source: "TicketX",
          },
          { headers: this.getHeaders(projectConfig), timeout: 20000 }
        );
      } else if (err.response?.status === 409 && err.response?.data?.id) {
        logger.info({ externalId: attachment.externalId }, "Plane attachment already exists (409 Conflict), using existing asset ID");
        return {
          attachmentId: String(err.response.data.id),
        };
      } else {
        throw err;
      }
    }

    const uploadData = registration.data?.upload_data;
    const assetId = registration.data?.asset_id || registration.data?.attachment?.id;
    if (!uploadData?.url || !uploadData?.fields || !assetId) {
      throw new Error("Plane attachment registration returned incomplete upload credentials");
    }

    const form = new FormData();
    for (const [key, value] of Object.entries(uploadData.fields)) {
      form.append(key, String(value));
    }
    form.append("file", new Blob([attachment.content as any], { type: attachment.type }), attachment.name);

    await this.httpClient.post(uploadData.url, form, { timeout: 30000 });

    const patchUrl = usedEndpoint.endsWith("/")
      ? `${usedEndpoint}${encodeURIComponent(String(assetId))}/`
      : `${usedEndpoint}/${encodeURIComponent(String(assetId))}/`;

    await this.httpClient.patch(
      patchUrl,
      {},
      { headers: this.getHeaders(projectConfig), timeout: 20000 }
    );

    const rawAssetUrl = typeof registration.data?.asset_url === "string"
      ? registration.data.asset_url
      : undefined;

    let fullAssetUrl = rawAssetUrl;
    if (rawAssetUrl && !rawAssetUrl.startsWith("http://") && !rawAssetUrl.startsWith("https://")) {
      const apiBase = (projectConfig.apiBaseUrl || config.PLANE_API_URL || "https://projects.oneweb.tech").replace(/\/+$/, "");
      fullAssetUrl = `${apiBase}${rawAssetUrl.startsWith("/") ? "" : "/"}${rawAssetUrl}`;
    }

    return { assetUrl: fullAssetUrl, attachmentId: String(assetId) };
  }

  /**
   * Retrieves project state definitions from Plane.
   */
  async listStates(projectConfig: PlaneProjectConfig): Promise<any[]> {
    const url = `${this.getProjectBaseUrl(projectConfig)}/states/`;
    const res = await this.httpClient.get(url, {
      headers: this.getHeaders(projectConfig),
      timeout: 20000,
    });

    if (Array.isArray(res.data)) return res.data;
    if (Array.isArray(res.data?.results)) return res.data.results;
    return [];
  }

  /**
   * Deletes a Work Item in Plane by ID.
   */
  async deleteWorkItem(projectConfig: PlaneProjectConfig, planeIssueId: string): Promise<boolean> {
    const url = `${this.getProjectBaseUrl(projectConfig)}/issues/${encodeURIComponent(planeIssueId)}/`;
    logger.info({ url, planeIssueId }, "Deleting work item in Plane project");

    try {
      await this.httpClient.delete(url, {
        headers: this.getHeaders(projectConfig),
        timeout: 10000,
      });
      return true;
    } catch (err: any) {
      if (err.response?.status === 404 || err.response?.status === 410) {
        return false;
      }
      throw err;
    }
  }
}
