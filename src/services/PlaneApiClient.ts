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
   * Classifies a failed Plane call as retryable or permanent.
   *
   * Retryable: network-level failures (no HTTP status), timeouts, 5xx, and 429.
   * Permanent: every other 4xx — 400/401/403/404/409 will not succeed on a
   * retry, and burning attempts on them only delays the outbox.
   */
  private isRetryable(err: any): boolean {
    const status = err?.response?.status;
    if (status === 429) return true;
    if (status === undefined || status === null) {
      // No response at all: DNS failure, connection reset, or client timeout.
      return true;
    }
    return status >= 500;
  }

  /**
   * Honours Plane's Retry-After header when present, otherwise falls back to
   * exponential backoff. Retry-After may be given in seconds or as an HTTP date.
   */
  private retryDelayMs(err: any, attempt: number, baseDelayMs: number): number {
    const backoff = baseDelayMs * Math.pow(2, attempt);
    const header = err?.response?.headers?.["retry-after"];
    if (header === undefined || header === null) return backoff;

    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      // Cap so a hostile or misconfigured header cannot stall the worker.
      return Math.min(seconds * 1000, 30000);
    }

    const retryAt = Date.parse(String(header));
    if (!Number.isNaN(retryAt)) {
      return Math.min(Math.max(retryAt - Date.now(), 0), 30000);
    }
    return backoff;
  }

  /**
   * Executes a Plane HTTP call, retrying transient failures with backoff.
   *
   * `onBeforeRetry` lets a non-idempotent caller (work item creation) check
   * whether the previous attempt actually succeeded before it is repeated. If
   * it returns a value, that value is used and no further request is made.
   */
  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    options: {
      maxRetries?: number;
      delayMs?: number;
      operation?: string;
      onBeforeRetry?: () => Promise<T | null>;
    } = {}
  ): Promise<T> {
    const { maxRetries = 2, delayMs = 1000, operation = "plane_request", onBeforeRetry } = options;
    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        if (attempt >= maxRetries || !this.isRetryable(err)) {
          throw err;
        }

        const waitTime = this.retryDelayMs(err, attempt, delayMs);
        logger.warn(
          {
            operation,
            attempt: attempt + 1,
            maxRetries,
            waitTime,
            status: err.response?.status,
            error: err.message,
          },
          "Transient Plane API error, retrying"
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));

        if (onBeforeRetry) {
          // The failed attempt may still have been applied by Plane (classic
          // timeout-after-write). Reconcile before issuing a duplicate write.
          const reconciled = await onBeforeRetry().catch((reconcileErr: any) => {
            logger.warn({ operation, error: reconcileErr.message }, "Retry reconciliation check failed");
            return null;
          });
          if (reconciled !== null && reconciled !== undefined) {
            logger.info({ operation }, "Previous attempt had already succeeded in Plane; skipping retry");
            return reconciled;
          }
        }
      }
    }
    throw lastError;
  }

  /**
   * Looks up a work item Plane already holds for a TicketX external id.
   * Returns null when Plane has no such item.
   */
  async findWorkItemByExternalId(
    projectConfig: PlaneProjectConfig,
    externalId: string
  ): Promise<{ id: string } | null> {
    const url = `${this.getProjectBaseUrl(projectConfig)}/issues/`;
    try {
      const res = await this.httpClient.get(url, {
        headers: this.getHeaders(projectConfig),
        params: { external_id: externalId, external_source: "TicketX" },
        timeout: 10000,
      });

      const rows = Array.isArray(res.data)
        ? res.data
        : Array.isArray(res.data?.results)
          ? res.data.results
          : [];
      const match = rows.find((r: any) => String(r?.external_id) === String(externalId)) || rows[0];
      return match?.id ? { id: String(match.id) } : null;
    } catch (err: any) {
      if (err.response?.status === 404) return null;
      throw err;
    }
  }

  /**
   * Creates a Work Item in the target Plane Project.
   */
  async createWorkItem(projectConfig: PlaneProjectConfig, payload: PlaneWorkItemPayload): Promise<{ id: string }> {
    const url = `${this.getProjectBaseUrl(projectConfig)}/issues/`;
    logger.info({ url, planeProjectId: projectConfig.planeProjectId }, "Creating work item in Plane project");

    try {
      return await this.executeWithRetry(
        async () => {
          const res = await this.httpClient.post(url, payload, {
            headers: this.getHeaders(projectConfig),
            timeout: 10000,
          });

          if (!res.data || !res.data.id) {
            throw new Error("Plane API creation failed: No ID returned in response payload");
          }

          return { id: String(res.data.id) };
        },
        {
          operation: "createWorkItem",
          // POST is not idempotent: a client timeout does not mean Plane failed
          // to create the issue. Check before retrying so a slow response can
          // never produce a duplicate work item.
          onBeforeRetry: () => this.findWorkItemByExternalId(projectConfig, payload.external_id),
        }
      );
    } catch (err: any) {
      if (err.response?.status === 409) {
        // Plane already holds an item for this external_id. Resolve its real
        // Plane UUID — returning payload.external_id here would store a
        // TicketX identifier in tickets.plane_issue_id and silently break
        // every later patch, status sync and reverse sync for this ticket.
        logger.info({ external_id: payload.external_id }, "Plane returned 409 Conflict: issue already created");
        const existing = await this.findWorkItemByExternalId(projectConfig, payload.external_id);
        if (existing) {
          return existing;
        }
        throw new Error(
          `PLANE_CONFLICT_UNRESOLVED: Plane reported a duplicate for external_id ${payload.external_id} but no matching work item could be retrieved`
        );
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

    // PATCH is idempotent, so it is safe to repeat without reconciliation.
    await this.executeWithRetry(
      async () => {
        await this.httpClient.patch(url, payload, {
          headers: this.getHeaders(projectConfig),
          timeout: 10000,
        });
      },
      { operation: "patchWorkItem" }
    );
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
