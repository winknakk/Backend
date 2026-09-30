/**
 * Plane comment → customer's LINE (demo 2.5, operator decision 2026-09-30).
 *
 * An engineer talks to the customer from the Plane work item by starting a
 * comment with "@ลูกค้า":
 *
 *   Plane:  "@ลูกค้า แก้ไขเซิร์ฟเวอร์เรียบร้อยแล้วค่ะ ลองใช้งานได้เลย"
 *   LINE:   "💬 ข้อความจากทีมงาน (TCK-…)\nแก้ไขเซิร์ฟเวอร์เรียบร้อยแล้วค่ะ ลองใช้งานได้เลย"
 *
 * Every other comment is an internal note and never leaves Plane. The bot's
 * own comments (customer feedback, close notes) start with an emoji header,
 * so they can never loop back.
 *
 * Plane does not deliver webhooks here (ISSUE-070), so the relay rides the
 * reverse-sync poller: one comments GET per open LINE ticket, at most once a
 * minute per ticket. At-most-once delivery comes from the notification
 * ledger's unique (notification_type, idempotency_key) = ("team_comment",
 * "plane_comment:<id>").
 */
import axios from "axios";
import { createLogger } from "../observability/logger";
import { customerNotificationService } from "./CustomerNotificationService";

const logger = createLogger("PlaneCommentRelay");

/** "@ลูกค้า", "@ ลูกค้า:", "@customer -" at the very start of the comment. */
const CUSTOMER_MARKER = /^\s*@\s*(?:ลูกค้า|customer)\s*[:：\-–]?\s*/i;

/** Comments older than this are never relayed (first run, long outages). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Per-ticket minimum gap between comment GETs (Plane throttles at ~40 req/min). */
const MIN_CHECK_GAP_MS = 60_000;

export interface PlaneComment {
  id?: string;
  comment_html?: string | null;
  comment_stripped?: string | null;
  created_at?: string | null;
}

/** Plain text of a Plane comment: `comment_stripped` when present, else the HTML with tags removed. */
export function planeCommentText(c: PlaneComment): string {
  const stripped = typeof c.comment_stripped === "string" ? c.comment_stripped : "";
  if (stripped.trim()) return stripped.replace(/\u00a0/g, " ").trim();
  return String(c.comment_html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The message for the customer, or null when the comment is an internal note (no "@ลูกค้า" at the start) or empty after the marker. */
export function customerMessageFromComment(c: PlaneComment): string | null {
  const text = planeCommentText(c);
  if (!CUSTOMER_MARKER.test(text)) return null;
  const message = text.replace(CUSTOMER_MARKER, "").trim();
  return message ? message.slice(0, 1500) : null;
}

/** Plane lists comments as an array or as `{ results: [...] }` depending on version. */
export function commentsFromResponse(data: unknown): PlaneComment[] {
  if (Array.isArray(data)) return data as PlaneComment[];
  const results = (data as any)?.results;
  return Array.isArray(results) ? (results as PlaneComment[]) : [];
}

export interface RelayTicket {
  id: number;
  ticket_number?: string | null;
  conversation_id?: number | null;
  project_id?: number | null;
  org_id?: string | null;
}

export interface RelayTarget {
  apiBase: string;
  workspaceSlug: string;
  planeProjectId: string;
  issueId: string;
  apiKey: string;
}

export type RelayResult = { checked: boolean; sent: number; rateLimited?: boolean; retryAfterMs?: number };

export class PlaneCommentRelay {
  private readonly lastCheckedAt = new Map<number, number>();

  constructor(
    private readonly httpClient: Pick<typeof axios, "get"> = axios,
    // Resolved at call time: CustomerNotificationService and the Plane
    // services import each other, so it may not exist yet at module load.
    private readonly notifierOverride?: Pick<typeof customerNotificationService, "send">,
    private readonly now: () => number = () => Date.now()
  ) {}

  private get notifier(): Pick<typeof customerNotificationService, "send"> {
    return this.notifierOverride ?? customerNotificationService;
  }

  /**
   * Relays new "@ลูกค้า" comments of one work item. Never throws; a 429 is
   * reported so the poller can stop its cycle like it does for issue GETs.
   */
  async relay(ticket: RelayTicket, target: RelayTarget): Promise<RelayResult> {
    if (!ticket.conversation_id) return { checked: false, sent: 0 };
    const last = this.lastCheckedAt.get(ticket.id) ?? 0;
    if (this.now() - last < MIN_CHECK_GAP_MS) return { checked: false, sent: 0 };
    this.lastCheckedAt.set(ticket.id, this.now());

    let comments: PlaneComment[];
    try {
      const url = `${target.apiBase}/api/v1/workspaces/${encodeURIComponent(target.workspaceSlug)}/projects/${encodeURIComponent(target.planeProjectId)}/issues/${encodeURIComponent(target.issueId)}/comments/`;
      const res = await this.httpClient.get(url, { headers: { "X-API-Key": target.apiKey }, timeout: 5000 });
      comments = commentsFromResponse(res.data);
    } catch (err: any) {
      if (err.response?.status === 429) {
        const retryAfter = Number(err.response?.headers?.["retry-after"]);
        return { checked: true, sent: 0, rateLimited: true, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 300_000) : 60_000 };
      }
      logger.warn({ ticketId: ticket.id, status: err.response?.status, error: err.message }, "Could not list Plane comments");
      return { checked: true, sent: 0 };
    }

    let sent = 0;
    const fresh = comments
      .filter((c) => c.id && c.created_at && this.now() - new Date(c.created_at).getTime() <= MAX_AGE_MS)
      .sort((a, b) => new Date(a.created_at as string).getTime() - new Date(b.created_at as string).getTime());
    for (const c of fresh) {
      const message = customerMessageFromComment(c);
      if (!message) continue;
      try {
        const r = await this.notifier.send({
          conversationId: Number(ticket.conversation_id),
          notificationType: "team_comment",
          idempotencyKey: `plane_comment:${c.id}`,
          ticketId: ticket.id,
          ticketNumber: ticket.ticket_number ?? null,
          projectId: ticket.project_id ?? null,
          orgId: ticket.org_id ?? null,
          correlationId: `plane_comment:${c.id}`,
          detail: message,
        });
        if (r.sent) {
          sent += 1;
          logger.info({ ticketId: ticket.id, commentId: c.id }, "Plane comment relayed to the customer");
        }
      } catch (err: any) {
        logger.warn({ ticketId: ticket.id, commentId: c.id, error: err.message }, "Plane comment relay send failed");
      }
    }
    return { checked: true, sent };
  }
}

export const planeCommentRelay = new PlaneCommentRelay();
