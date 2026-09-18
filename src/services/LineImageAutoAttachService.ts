import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";
import { customerNotificationService } from "./CustomerNotificationService";

const logger = createLogger("line-image-auto-attach");

/**
 * A screenshot sent on its own right after a case was opened belongs to that
 * case (operator decision 2026-09-17; before that every standalone image was
 * asked about first). "Right after" is LINE_IMAGE_AUTO_ATTACH_MINUTES from the
 * focus case's creation — the focus (`conversations.active_ticket_id`) is set
 * by the hub on create, so it is the case the customer just confirmed.
 * Outside the window, with no focus case, or when Plane refuses the upload,
 * the ask-first path in lineWebhook runs unchanged.
 */

export interface AutoAttachTarget {
  id: number;
  ticket_number: string;
  subject: string | null;
  plane_issue_id: string | null;
  created_at: Date | string;
}

export type AutoAttachDecision = "attach" | "pending_promotion" | "skip";

/** Pure: is the case young enough for a silent attach? `windowMinutes <= 0` disables the feature. */
export function isWithinAutoAttachWindow(createdAt: Date | string | null | undefined, windowMinutes: number, now: number = Date.now()): boolean {
  if (!createdAt || !(windowMinutes > 0)) return false;
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return false;
  return now - created <= windowMinutes * 60_000 && created <= now + 60_000;
}

/** Pure: what to do with a standalone screenshot given the focus case (or none). */
export function decideAutoAttach(target: AutoAttachTarget | null, windowMinutes: number, now: number = Date.now()): AutoAttachDecision {
  if (!target || !isWithinAutoAttachWindow(target.created_at, windowMinutes, now)) return "skip";
  const planeId = String(target.plane_issue_id || "").trim();
  // Promotion has not finished yet: promoteTicketToPlane → pushConversationImagesToIssue
  // collects every unpushed image newer than the previous case, so the screenshot
  // lands on the work item as soon as it exists.
  if (!planeId || planeId.startsWith("mock-")) return "pending_promotion";
  return "attach";
}

/** Burst: one message per minute; later screenshots in the same burst attach silently. */
const REPLY_BURST_SECONDS = 60;

export interface AutoAttachInput {
  conversationId: number;
  projectId?: number | null;
  idempotencyKey: string;
  correlationId?: string;
}

export type AutoAttachOutcome = "attached" | "pending_promotion" | "skipped" | "attach_failed";

export class LineImageAutoAttachService {
  /** The conversation's focus case when it is still open; null otherwise. */
  async findFocusCase(conversationId: number): Promise<AutoAttachTarget | null> {
    const { rows } = await pool.query<AutoAttachTarget>(
      `SELECT t.id, t.ticket_number, t.subject, t.plane_issue_id, t.created_at
         FROM conversations c
         JOIN tickets t ON t.id = c.active_ticket_id
        WHERE c.id = $1::integer
          AND t.deleted_at IS NULL
          AND UPPER(COALESCE(t.status, '')) NOT IN ('CLOSED', 'CANCELLED')
        LIMIT 1`,
      [conversationId]
    );
    return rows[0] ?? null;
  }

  /**
   * Attaches the conversation's unpushed screenshots to the just-opened focus
   * case and tells the customer once per burst. Never throws: any failure is
   * reported as `attach_failed` / `skipped` so the caller can fall back to
   * asking.
   */
  async autoAttachStandaloneImage(input: AutoAttachInput): Promise<{ outcome: AutoAttachOutcome; ticketNumber?: string }> {
    try {
      const target = await this.findFocusCase(input.conversationId);
      const decision = decideAutoAttach(target, config.LINE_IMAGE_AUTO_ATTACH_MINUTES);
      if (decision === "skip" || !target) return { outcome: "skipped" };

      if (decision === "attach") {
        const { PlaneService } = await import("./planeService");
        const { AdapterFactory } = await import("../adapters/AdapterFactory");
        const planeService = new PlaneService(AdapterFactory.getAdapter());
        const r = await planeService.attachPendingImagesToTicketNumber(input.conversationId, target.ticket_number);
        if (r.attached <= 0) {
          logger.warn({ conversationId: input.conversationId, ticket: target.ticket_number }, "Auto-attach pushed nothing; falling back to the ask-first path");
          return { outcome: "attach_failed", ticketNumber: target.ticket_number };
        }
      }

      const type = decision === "attach" ? "image_auto_attached" : "image_auto_attach_pending";
      if (await this.repliedRecently(input.conversationId)) {
        logger.info({ conversationId: input.conversationId, ticket: target.ticket_number, type }, "Auto-attach reply suppressed: one was sent for this burst");
      } else {
        await customerNotificationService.send({
          conversationId: input.conversationId,
          notificationType: type,
          idempotencyKey: input.idempotencyKey,
          ticketId: target.id,
          ticketNumber: target.ticket_number,
          subject: target.subject ?? null,
          projectId: input.projectId ?? null,
          correlationId: input.correlationId ?? null,
          quickReplies: [],
        });
      }
      return { outcome: decision === "attach" ? "attached" : "pending_promotion", ticketNumber: target.ticket_number };
    } catch (err: any) {
      logger.error({ error: err.message, conversationId: input.conversationId }, "Auto-attach failed; falling back to the ask-first path");
      return { outcome: "attach_failed" };
    }
  }

  private async repliedRecently(conversationId: number): Promise<boolean> {
    const { rows } = await pool.query(
      `SELECT 1 FROM customer_notifications
        WHERE conversation_id = $1::integer
          AND notification_type IN ('image_auto_attached', 'image_auto_attach_pending')
          AND created_at >= NOW() - ($2::int * INTERVAL '1 second')
        LIMIT 1`,
      [conversationId, REPLY_BURST_SECONDS]
    );
    return rows.length > 0;
  }
}

export const lineImageAutoAttachService = new LineImageAutoAttachService();
