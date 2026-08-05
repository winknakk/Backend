import crypto from "crypto";
import axios from "axios";
import { DatabaseAdapter } from "../adapters/types";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";

const logger = createLogger("planeWebhookService");

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
  deleted?: boolean;
  reason?: string;
  planeIssueId?: string;
  status?: string;
  priority?: string;
}

export interface PlaneReverseSyncSummary {
  checked: number;
  updated: number;
  deleted: number;
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
    closed: "Done",
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
    urgent: "Urgent",
    high: "High",
    medium: "Medium",
    low: "Low",
    none: "None",
  };
  return priorityMap[priority.trim().toLowerCase()];
}

export function mapTicketPriorityToPlanePriority(priority?: string | null): string | undefined {
  if (!priority) return undefined;
  const priorityMap: Record<string, string> = {
    p1: "urgent",
    urgent: "urgent",
    p2: "high",
    high: "high",
    p3: "medium",
    medium: "medium",
    p4: "low",
    low: "low",
    none: "none",
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
  constructor(
    private readonly dbAdapter: DatabaseAdapter,
    private readonly httpClient: Pick<typeof axios, "get"> = axios
  ) {}

  async sync(payload: PlaneWebhookPayload): Promise<PlaneWebhookSyncResult> {
    const event = payload.event?.toLowerCase();
    const action = payload.action?.toLowerCase();
    if (
      (event !== "issue" && event !== "work_item") ||
      (action !== "update" && action !== "create" && action !== "delete")
    ) {
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

    if (action === "delete") {
      if (!this.dbAdapter.deleteTicketFromPlane) {
        return {
          processed: false,
          matched: false,
          deleted: false,
          reason: "delete_not_supported",
          planeIssueId,
        };
      }
      const deleted = await this.dbAdapter.deleteTicketFromPlane(planeIssueId);
      return {
        processed: true,
        matched: deleted,
        deleted,
        reason: deleted ? undefined : "ticket_not_linked",
        planeIssueId,
      };
    }

    const state = await this.resolveState(data, payloadProjectId || configuredProjectId);
    // Plane can set completed_at on a cancelled work item too. Prefer the
    // explicit state so Cancelled never gets flattened into Done.
    const status = mapPlaneStateToTicketStatus(state) || (data.completed_at ? "Done" : undefined);
    const priority = mapPlanePriorityToTicketPriority(data.priority);
    if (!status && !priority) {
      return { processed: false, matched: false, reason: "no_supported_changes", planeIssueId };
    }

    const matched = await this.dbAdapter.syncTicketFromPlane(planeIssueId, { status, priority });
    if (matched && status === "Done") {
      this.dispatchCustomerDoneNotification(planeIssueId).catch((err) => {
        logger.error({ error: err.message, planeIssueId }, "Failed to dispatch customer Done notification");
      });
    }

    return {
      processed: true,
      matched,
      reason: matched ? undefined : "ticket_not_linked",
      planeIssueId,
      status,
      priority,
    };
  }

  private async dispatchCustomerDoneNotification(planeIssueId: string): Promise<void> {
    try {
      const { pool } = require("../adapters/postgres/PostgresAdapter");
      const { rows } = await pool.query(
        `SELECT t.id, t.ticket_number, t.subject, t.conversation_id, c.channel, i.channel_ref
         FROM tickets t
         JOIN conversations c ON c.id = t.conversation_id
         JOIN identities i ON i.id = c.identity_id
         WHERE t.plane_issue_id = $1 LIMIT 1`,
        [planeIssueId]
      );

      if (rows.length === 0) return;
      const ticket = rows[0];
      const notificationText = `🎉 ตั๋วของคุณ #${ticket.ticket_number || ticket.id} ("${ticket.subject}") ได้รับการแก้ไขและอัปเดตสถานะเป็น Done เรียบร้อยแล้วค่ะ`;

      await this.dbAdapter.saveMessage(String(ticket.conversation_id), "ai", notificationText);

      if (ticket.channel === "line" || ticket.channel === "line_group") {
        const token = (config.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
        if (token && ticket.channel_ref && !ticket.channel_ref.startsWith("test_")) {
          await axios.post(
            "https://api.line.me/v2/bot/message/push",
            {
              to: ticket.channel_ref,
              messages: [{ type: "text", text: notificationText }],
            },
            {
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              timeout: 10000,
            }
          );
        }
      }
    } catch (err: any) {
      logger.error({ error: err.message, planeIssueId }, "Error sending customer Done notification");
    }
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

    const summary: PlaneReverseSyncSummary = { checked: 0, updated: 0, deleted: 0, unlinked: 0, failed: 0 };
    for (const planeIssueId of linkedIssueIds) {
      summary.checked += 1;
      try {
        const url = `${config.PLANE_API_URL}/api/v1/workspaces/${config.PLANE_WORKSPACE_SLUG}/projects/${config.PLANE_PROJECT_ID}/work-items/${planeIssueId}/`;
        const response = await this.httpClient.get(url, {
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
      } catch (error: any) {
        if (error?.response?.status === 404 && this.dbAdapter.deleteTicketFromPlane) {
          try {
            const deleted = await this.dbAdapter.deleteTicketFromPlane(planeIssueId);
            if (deleted) summary.deleted += 1;
            else summary.unlinked += 1;
          } catch {
            summary.failed += 1;
          }
        } else {
          summary.failed += 1;
        }
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
    const response = await this.httpClient.get(url, {
      headers: { "X-API-Key": config.PLANE_API_KEY },
      timeout: 5000,
    });
    return { name: response.data?.name, group: response.data?.group };
  }
}
