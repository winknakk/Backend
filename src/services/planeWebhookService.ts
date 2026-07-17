import crypto from "crypto";
import axios from "axios";
import { DatabaseAdapter } from "../adapters/types";
import { config } from "../config/env";

export interface PlaneWebhookPayload {
  event?: string;
  action?: string;
  workspace_id?: string;
  data?: {
    id?: string;
    project?: string | { id?: string };
    priority?: string | null;
    completed_at?: string | null;
    state?: string | { id?: string; name?: string; group?: string } | null;
    state_detail?: { id?: string; name?: string; group?: string } | null;
    state_name?: string | null;
    state_group?: string | null;
  };
}

export interface PlaneWebhookSyncResult {
  processed: boolean;
  matched: boolean;
  reason?: string;
  planeIssueId?: string;
  status?: string;
  priority?: string;
}

export interface PlaneReverseSyncSummary {
  checked: number;
  updated: number;
  unlinked: number;
  failed: number;
}

function canonicalStatusName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  const known: Record<string, string> = {
    backlog: "Backlog",
    open: "Backlog",
    todo: "Todo",
    "to do": "Todo",
    unstarted: "Todo",
    started: "In Progress",
    "in progress": "In Progress",
    completed: "Done",
    complete: "Done",
    done: "Done",
    resolved: "Done",
    cancelled: "Cancelled",
    canceled: "Cancelled",
  };
  return known[normalized] || name.trim();
}

export function mapPlaneStateToTicketStatus(state?: { name?: string; group?: string } | null): string | undefined {
  if (!state) return undefined;
  if (state.name?.trim()) return canonicalStatusName(state.name);

  const groupMap: Record<string, string> = {
    backlog: "Backlog",
    unstarted: "Todo",
    started: "In Progress",
    completed: "Done",
    cancelled: "Cancelled",
    canceled: "Cancelled",
  };
  return state.group ? groupMap[state.group.trim().toLowerCase()] : undefined;
}

export function mapPlanePriorityToTicketPriority(priority?: string | null): string | undefined {
  if (!priority) return undefined;
  const priorityMap: Record<string, string> = {
    urgent: "P1",
    high: "P2",
    medium: "P3",
    low: "P4",
    none: "P4",
  };
  return priorityMap[priority.trim().toLowerCase()];
}

export function verifyPlaneWebhookSignature(
  payload: unknown,
  receivedSignature: string | undefined,
  secret: string | undefined
): boolean {
  if (!secret || !receivedSignature || !/^[a-f0-9]{64}$/i.test(receivedSignature)) return false;

  const expected = crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
  const receivedBuffer = Buffer.from(receivedSignature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

export class PlaneWebhookService {
  constructor(private readonly dbAdapter: DatabaseAdapter) {}

  async sync(payload: PlaneWebhookPayload): Promise<PlaneWebhookSyncResult> {
    const event = payload.event?.toLowerCase();
    const action = payload.action?.toLowerCase();
    if ((event !== "issue" && event !== "work_item") || (action !== "update" && action !== "create")) {
      return { processed: false, matched: false, reason: "unsupported_event" };
    }

    const data = payload.data;
    const planeIssueId = data?.id;
    if (!data || !planeIssueId) {
      throw new Error("Plane webhook payload is missing data.id");
    }

    const payloadProjectId = typeof data.project === "string" ? data.project : data.project?.id;
    const configuredProjectId = config.PLANE_PROJECT_ID;
    if (
      payloadProjectId &&
      configuredProjectId &&
      configuredProjectId !== "proj_id" &&
      payloadProjectId !== configuredProjectId
    ) {
      return { processed: false, matched: false, reason: "project_mismatch", planeIssueId };
    }

    const state = await this.resolveState(data, payloadProjectId || configuredProjectId);
    const status = data.completed_at ? "Done" : mapPlaneStateToTicketStatus(state);
    const priority = mapPlanePriorityToTicketPriority(data.priority);
    if (!status && !priority) {
      return { processed: false, matched: false, reason: "no_supported_changes", planeIssueId };
    }

    const matched = await this.dbAdapter.syncTicketFromPlane(planeIssueId, { status, priority });
    return {
      processed: true,
      matched,
      reason: matched ? undefined : "ticket_not_linked",
      planeIssueId,
      status,
      priority,
    };
  }

  async syncLinkedTicketsFromPlane(batchSize = config.PLANE_REVERSE_SYNC_BATCH_SIZE): Promise<PlaneReverseSyncSummary> {
    if (
      !config.PLANE_API_KEY ||
      config.PLANE_API_KEY === "plane_mock_key" ||
      !config.PLANE_PROJECT_ID ||
      config.PLANE_PROJECT_ID === "proj_id" ||
      !config.PLANE_WORKSPACE_SLUG ||
      config.PLANE_WORKSPACE_SLUG === "ws_id"
    ) {
      throw new Error("Plane reverse sync credentials are not configured");
    }

    const tickets = await this.dbAdapter.listAllTickets();
    const linkedIssueIds = Array.from(
      new Set(
        tickets
          .map((ticket: any) => ticket.planeIssueId || ticket.plane_issue_id)
          .filter((issueId: unknown): issueId is string => typeof issueId === "string" && issueId.length > 0)
      )
    ).slice(0, batchSize);

    const summary: PlaneReverseSyncSummary = { checked: 0, updated: 0, unlinked: 0, failed: 0 };
    for (const planeIssueId of linkedIssueIds) {
      summary.checked += 1;
      try {
        const url = `${config.PLANE_API_URL}/api/v1/workspaces/${config.PLANE_WORKSPACE_SLUG}/projects/${config.PLANE_PROJECT_ID}/work-items/${planeIssueId}/`;
        const response = await axios.get(url, {
          headers: { "X-API-Key": config.PLANE_API_KEY },
          params: { expand: "state" },
          timeout: 5000,
        });
        const result = await this.sync({
          event: "issue",
          action: "update",
          workspace_id: response.data?.workspace,
          data: response.data,
        });
        if (result.matched) summary.updated += 1;
        else summary.unlinked += 1;
      } catch {
        summary.failed += 1;
      }
    }
    return summary;
  }

  private async resolveState(
    data: NonNullable<PlaneWebhookPayload["data"]>,
    projectId?: string
  ): Promise<{ name?: string; group?: string } | undefined> {
    if (data.state_detail) return data.state_detail;
    if (typeof data.state === "object" && data.state) return data.state;
    if (data.state_name || data.state_group) {
      return { name: data.state_name || undefined, group: data.state_group || undefined };
    }
    if (!data.state || typeof data.state !== "string") return undefined;

    if (
      !config.PLANE_API_KEY ||
      config.PLANE_API_KEY === "plane_mock_key" ||
      !projectId ||
      projectId === "proj_id" ||
      !config.PLANE_WORKSPACE_SLUG ||
      config.PLANE_WORKSPACE_SLUG === "ws_id"
    ) {
      throw new Error("Plane state lookup is not configured");
    }

    const url = `${config.PLANE_API_URL}/api/v1/workspaces/${config.PLANE_WORKSPACE_SLUG}/projects/${projectId}/states/${data.state}/`;
    const response = await axios.get(url, {
      headers: { "X-API-Key": config.PLANE_API_KEY },
      timeout: 5000,
    });
    return { name: response.data?.name, group: response.data?.group };
  }
}
