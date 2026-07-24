import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { randomUUID } from "crypto";
import { DatabaseAdapter } from "../adapters/types";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";

export interface PlaneStateSummary {
  id?: string;
  name?: string;
  group?: string;
}

export interface PlaneTicketClosureResult {
  synced: boolean;
  reason?: "not_linked";
  planeIssueId?: string;
  stateId?: string;
  stateName?: string;
  stateGroup?: string;
}

export function selectPlaneTerminalState(states: PlaneStateSummary[]): PlaneStateSummary | undefined {
  const byGroup = (group: string) =>
    states.filter((state) => state.group?.trim().toLowerCase() === group && state.id);
  const completed = byGroup("completed");
  const cancelled = byGroup("cancelled");

  const pickPreferred = (candidates: PlaneStateSummary[], names: string[]) => {
    for (const name of names) {
      const match = candidates.find((state) => state.name?.trim().toLowerCase() === name);
      if (match) return match;
    }
    return candidates[0];
  };

  return (
    pickPreferred(completed, ["done", "completed", "closed", "resolved"]) ||
    pickPreferred(cancelled, ["cancelled", "canceled"])
  );
}

export function findMatchingPlaneWorkItem(
  subject: string,
  workItems: Array<{ id?: string; name?: string }>
): { id?: string; name?: string } | undefined {
  const normalizedSubject = subject.trim().toLowerCase().replace(/\s+/g, " ");
  const exactMatches = workItems.filter(
    (workItem) =>
      workItem.id && String(workItem.name || "").trim().toLowerCase().replace(/\s+/g, " ") === normalizedSubject
  );
  if (exactMatches.length === 1) return exactMatches[0];

  // Ticket titles commonly include an HTTP status code while the Plane creation
  // flow may shorten surrounding Thai wording. A unique code is a safer repair
  // key than broad fuzzy matching.
  const httpCode = normalizedSubject.match(/\b[1-5]\d{2}\b/)?.[0];
  if (!httpCode) return undefined;
  const codeMatches = workItems.filter(
    (workItem) => workItem.id && String(workItem.name || "").match(/\b[1-5]\d{2}\b/)?.[0] === httpCode
  );
  return codeMatches.length === 1 ? codeMatches[0] : undefined;
}

export class PlaneService {
  private dbAdapter: DatabaseAdapter;
  private httpClient: typeof axios;

  constructor(dbAdapter: DatabaseAdapter, httpClient: typeof axios = axios) {
    this.dbAdapter = dbAdapter;
    this.httpClient = httpClient;
  }

  private getProjectBaseUrl(): string {
    return `${config.PLANE_API_URL}/api/v1/workspaces/${encodeURIComponent(config.PLANE_WORKSPACE_SLUG)}/projects/${encodeURIComponent(config.PLANE_PROJECT_ID)}`;
  }

  private getPlaneRequestConfig() {
    return {
      headers: { "X-API-Key": config.PLANE_API_KEY },
      timeout: 5000,
    };
  }

  private assertPlaneConfigured(): void {
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

  async resolvePlaneWorkItemId(ticketId: string, candidateId: string): Promise<string> {
    this.assertPlaneConfigured();
    const { ticket } = await this.dbAdapter.getTicketCompanyContext(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

    const projectBaseUrl = this.getProjectBaseUrl();
    const requestConfig = this.getPlaneRequestConfig();
    try {
      await this.httpClient.get(
        `${projectBaseUrl}/work-items/${encodeURIComponent(String(candidateId))}/`,
        requestConfig
      );
      return String(candidateId);
    } catch (error: any) {
      const status = error?.response?.status;
      if (status !== 403 && status !== 404) throw error;
    }

    const listResponse = await this.httpClient.get(`${projectBaseUrl}/work-items/`, {
      ...requestConfig,
      params: { per_page: 100, fields: "id,name,sequence_id" },
    });
    const workItems = Array.isArray(listResponse.data)
      ? listResponse.data
      : Array.isArray(listResponse.data?.results)
        ? listResponse.data.results
        : [];
    const subject = String(ticket.subject || "").trim();
    const matchingWorkItem = findMatchingPlaneWorkItem(subject, workItems);
    if (!matchingWorkItem?.id) {
      throw new Error(
        `Cannot repair Plane link for ticket ${ticketId}: no unique matching work item was found`
      );
    }
    return String(matchingWorkItem.id);
  }

  async syncTicketClosureToPlane(ticketId: string): Promise<PlaneTicketClosureResult> {
    const { ticket } = await this.dbAdapter.getTicketCompanyContext(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

    const planeIssueId = ticket.planeIssueId || ticket.plane_issue_id;
    if (!planeIssueId || String(planeIssueId).startsWith("mock-")) {
      return { synced: false, reason: "not_linked" };
    }

    this.assertPlaneConfigured();

    const resolvedPlaneIssueId = await this.resolvePlaneWorkItemId(ticketId, String(planeIssueId));
    if (resolvedPlaneIssueId !== String(planeIssueId)) {
      await this.dbAdapter.updateTicketPlaneIssue(ticketId, resolvedPlaneIssueId);
    }

    const projectBaseUrl = this.getProjectBaseUrl();
    const requestConfig = this.getPlaneRequestConfig();
    const statesResponse = await this.httpClient.get(`${projectBaseUrl}/states/`, requestConfig);
    const states = Array.isArray(statesResponse.data)
      ? statesResponse.data
      : Array.isArray(statesResponse.data?.results)
        ? statesResponse.data.results
        : [];
    const terminalState = selectPlaneTerminalState(states);
    if (!terminalState?.id) {
      throw new Error("Cannot close linked Plane work item: project has no completed or cancelled state");
    }

    await this.httpClient.patch(
      `${projectBaseUrl}/work-items/${encodeURIComponent(resolvedPlaneIssueId)}/`,
      { state: terminalState.id },
      requestConfig
    );

    return {
      synced: true,
      planeIssueId: resolvedPlaneIssueId,
      stateId: terminalState.id,
      stateName: terminalState.name,
      stateGroup: terminalState.group,
    };
  }

  private getFilePath(tableName: string): string {
    const candidates = [
      path.resolve(__dirname, "../../../data"),
      path.resolve(process.cwd(), "data"),
      path.resolve(process.cwd(), "ticket_codebase/data"),
    ];

    let dataDir = candidates[0];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        const files = fs.readdirSync(cand);
        const hasData = files.some(
          (f) =>
            f.endsWith(".json") &&
            (f.includes("Tickets") || f.includes("Messages") || f.includes("Projects"))
        );
        if (hasData) {
          dataDir = cand;
          break;
        }
      }
    }

    const files = fs.readdirSync(dataDir);
    const match =
      files.find((f) => f.includes(`(${tableName})`) && f.endsWith(".json")) ||
      files.find((f) => f.includes(tableName) && f.endsWith(".json"));
    if (!match) {
      const defaultFilename = `Ticket V.2 - ${tableName} (${tableName}).json`;
      return path.join(dataDir, defaultFilename);
    }
    return path.join(dataDir, match);
  }

  private readTable<T>(tableName: string): T[] {
    const filePath = this.getFilePath(tableName);
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T[];
  }

  private writeTable<T>(tableName: string, data: T[]): void {
    const filePath = this.getFilePath(tableName);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async promoteTicketToPlane(ticketId: string): Promise<any> {
    // 1. Fetch ticket and company details using adapter
    const { ticket, companyName } = await this.dbAdapter.getTicketCompanyContext(ticketId);

    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }

    let planeIssueId = `mock-issue-${randomUUID()}`;
    let webhookTriggered = false;

    // 2. Trigger Activepieces webhook if configured
    const webhookUrl = config.ACTIVEPIECES_WORKFLOW_PROVIDER === "postgres_v2"
      ? config.ACTIVEPIECES_PROMOTE_TICKET_WEBHOOK_URL_V2
      : config.ACTIVEPIECES_PROMOTE_TICKET_WEBHOOK_URL;

    if (webhookUrl) {
      try {
        console.log(`[PlaneService] Triggering Activepieces Promote webhook at ${webhookUrl}...`);
        await this.httpClient.post(
          webhookUrl,
          {
            ticket_internal_id: Number(ticketId) || ticketId,
          },
          {
            headers: {
              "Content-Type": "application/json",
            },
            timeout: 5000,
          }
        );
        console.log(`[PlaneService] Activepieces webhook called successfully.`);
        planeIssueId = "Promoted via Activepieces webhook";
        webhookTriggered = true;
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || err.message;
        console.error(`[PlaneService] Failed to trigger Activepieces promote webhook:`, errorMsg);
      }
    }

    // 3. Fallback to direct Plane API call if webhook was not triggered/configured
    if (!webhookTriggered) {
      const useMockMode =
        !config.PLANE_API_KEY ||
        config.PLANE_API_KEY === "plane_mock_key" ||
        !config.PLANE_PROJECT_ID ||
        config.PLANE_PROJECT_ID === "proj_id";

      if (!useMockMode) {
        try {
          console.log(`[PlaneService] Promoting ticket ${ticketId} to Plane API...`);
          const url = `${config.PLANE_API_URL}/api/v1/workspaces/${config.PLANE_WORKSPACE_SLUG}/projects/${config.PLANE_PROJECT_ID}/issues/`;
          const res = await this.httpClient.post(
            url,
            {
              name: ticket.subject || "No Subject",
              description: `${ticket.summary || "No Summary"}\n\n[Customer Company: ${companyName}]`,
              priority: ticket.priority ? ticket.priority.toLowerCase() : "medium",
            },
            {
              headers: {
                "Content-Type": "application/json",
                "X-API-Key": config.PLANE_API_KEY,
              },
              timeout: 5000,
            }
          );
          if (res.data && res.data.id) {
            planeIssueId = res.data.id;
            console.log(`[PlaneService] Plane issue created successfully with ID: ${planeIssueId}`);
          }
        } catch (err: any) {
          const errorMsg = err.response?.data?.message || err.message;
          console.error(`[PlaneService] Plane API promotion failed, falling back to mock mode:`, errorMsg);
        }
      } else {
        console.log(`[PlaneService] Plane credentials are not configured or set to mock keys. Running in Mock Mode.`);
      }

      // Update plane_issue_id and status in database directly
      await this.dbAdapter.updateTicketPlaneIssue(ticketId, planeIssueId);
    }

    return {
      success: true,
      plane_issue_id: planeIssueId,
      ticket_id: ticket.ticket_id || ticket.id1,
      status: "In Progress",
    };
  }
}

