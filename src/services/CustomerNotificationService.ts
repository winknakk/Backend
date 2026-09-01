import axios from "axios";
import { createHash } from "crypto";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";
import { traceRecorder } from "../observability/TraceRecorder";

const logger = createLogger("customer-notification");

export type CustomerNotificationType =
  | "acknowledgement"
  | "acknowledgement_action"
  | "greeting"
  | "thanks"
  | "image_attached"
  | "image_confirm_case"
  | "image_which_case"
  | "image_case_not_found"
  | "image_need_context"
  | "unsupported_file"
  | "ticket_created"
  | "resolution_confirmation"
  | "closed"
  | "reopened";

export interface SendRequest {
  conversationId: number;
  notificationType: CustomerNotificationType;
  /** Deterministic per logical event — a retried webhook must produce the same key. */
  idempotencyKey: string;
  ticketId?: number | null;
  ticketNumber?: string | null;
  projectId?: number | null;
  orgId?: string | null;
  correlationId?: string | null;
  /** Optional case subject, shown when asking which case an image belongs to. */
  subject?: string | null;
}

/**
 * How long one acknowledgement covers a burst of customer messages. Long
 * enough to span a multi-part report plus its screenshots, short enough that a
 * genuinely new report minutes later is acknowledged again.
 */
const ACK_BURST_WINDOW_SECONDS = 90;

export interface SendResult {
  sent: boolean;
  /** True when this notification had already been sent for this key. */
  duplicate?: boolean;
  reason?: string;
  body?: string;
}

/**
 * Customer-facing messages for the Golden Flow.
 *
 * Two rules shape this service:
 *
 * 1. At most once. LINE retries webhooks, the reverse-sync poller re-reads
 *    the same Plane state every cycle, and an operator can resolve twice.
 *    A unique index on (notification_type, idempotency_key) is what enforces
 *    it — the row is claimed before the message is sent, so two concurrent
 *    senders cannot both deliver.
 *
 * 2. Never overstate. An acknowledgement says the report was received and is
 *    being looked at. It does not say an engineer has fixed anything, and it
 *    does not invent a case number that does not exist yet.
 *
 * 3. One voice. The assistant is female throughout the product, so every
 *    string here ends in ค่ะ / นะคะ and never in the male particle. The LINE
 *    onboarding path already enforces this by test; these messages share the
 *    same chat thread and were the last place still answering as a man.
 *    test-line-project-onboarding.ts greps this file, so keep the male
 *    particle out of the comments here too.
 */
export class CustomerNotificationService {
  /**
   * Acknowledgement variants. Every one is intent-neutral (fires before
   * classification, so it must read naturally for a question as well as an
   * incident report), promises nothing beyond "received, looking", and ends
   * in the female particle. Picked deterministically from the idempotency
   * key so a LINE webhook retry can never produce a differently-worded
   * duplicate, while consecutive messages still vary.
   */
  private static readonly ACK_VARIANTS = [
    "รับเรื่องแล้วนะคะ ขอเวลาสักครู่ค่ะ",
    "รับเรื่องไว้แล้วค่ะ เดี๋ยวแอดมินดูให้นะคะ",
    "รับทราบค่ะ ขอแอดมินดูสักครู่นะคะ",
    "รับเรื่องแล้วค่ะ รอสักครู่นะคะ",
  ] as const;

  /**
   * Action Acknowledgement variants for short confirmation/cancellation turns.
   */
  private static readonly ACK_ACTION_VARIANTS = [
    "รับทราบค่ะ",
    "รับเรื่องค่ะ",
    "รับทราบเรียบร้อยค่ะ",
    "รับเรื่องแล้วนะคะ",
  ] as const;

  /**
   * Complete replies for turns the webhook answers at the edge: a pure
   * greeting or pure thanks never reaches the AI (see detectPureSmallTalk in
   * lineWebhook), so this line is the whole conversation turn, not a stall.
   */
  private static readonly GREETING_VARIANTS = [
    "สวัสดีค่ะ มีอะไรให้แอดมินช่วยดูแลไหมคะ",
    "สวัสดีค่ะ แจ้งเรื่องหรือสอบถามเข้ามาได้เลยนะคะ",
    "สวัสดีค่า มีอะไรให้แอดมินช่วยบอกได้เลยนะคะ",
  ] as const;

  private static readonly THANKS_VARIANTS = [
    "ยินดีค่ะ มีอะไรให้ช่วยอีกแจ้งได้เลยนะคะ",
    "ยินดีดูแลเสมอค่ะ",
    "ขอบคุณเช่นกันนะคะ มีอะไรเพิ่มเติมแจ้งได้เลยค่ะ",
  ] as const;

  private static pickVariant(variants: readonly string[], seed?: string | null): string {
    if (!seed) return variants[0];
    const digest = createHash("sha256").update(seed).digest();
    return variants[digest[0] % variants.length];
  }

  /** Wording is deliberately conservative — see rule 2 above. */
  private body(type: CustomerNotificationType, ticketNumber?: string | null, seed?: string | null, subject?: string | null): string {
    switch (type) {
      case "acknowledgement":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.ACK_VARIANTS, seed);
      case "acknowledgement_action":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.ACK_ACTION_VARIANTS, seed);
      case "greeting":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.GREETING_VARIANTS, seed);
      case "thanks":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.THANKS_VARIANTS, seed);
      // Screenshot landed on an existing case. Naming the case is the point of
      // the message, so the number is stated when it is known.
      case "image_attached":
        return ticketNumber
          ? `ได้รับรูปแล้วนะคะ แนบเข้าเคส ${ticketNumber} ให้เรียบร้อยแล้วค่ะ`
          : "ได้รับรูปแล้วนะคะ แนบเข้าเคสให้เรียบร้อยแล้วค่ะ";
      // A standalone screenshot is never attached on a guess — ask which case
      // it belongs to. The lineWebhook pending-reply handler resolves the
      // answer (ใช่ / ไม่ใช่ / เลขเคส / ชื่อเรื่อง) deterministically.
      case "image_confirm_case": {
        // Truncating mid-word read as a glitch ("...ไม่ถูกต้") — allow the full
        // subject up to a sane cap and mark a real cut with an ellipsis.
        const raw = String(subject || "").trim();
        const shown = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
        const about = shown ? ` เรื่อง "${shown}"` : "";
        return ticketNumber
          ? `ได้รับรูปแล้วนะคะ รูปนี้เป็นของเคสล่าสุด ${ticketNumber}${about} ใช่ไหมคะ`
          : "ได้รับรูปแล้วนะคะ เป็นรูปของเคสที่แจ้งไว้ล่าสุดใช่ไหมคะ";
      }
      case "image_which_case":
        return "รบกวนบอกเลขเคส (TCK-...) หรือพิมพ์ชื่อเรื่องที่แจ้งไว้หน่อยนะคะ แอดมินจะได้แนบรูปให้ถูกเคสค่ะ";
      case "image_case_not_found":
        return "แอดมินยังไม่พบเคสตามที่แจ้งเลยค่ะ รบกวนเช็คเลขเคสอีกครั้งนะคะ";
      // A file / clip the pipeline cannot read: say so at once with the fix in
      // hand, instead of acknowledging and sending an empty turn to the AI.
      case "unsupported_file":
        return "ขออภัยค่ะ ไฟล์แบบนี้แอดมินยังเปิดดูไม่ได้ค่ะ รบกวนส่งเป็นรูปภาพ (PNG หรือ JPG) หรือพิมพ์อธิบายอาการมาได้เลยนะคะ";
      // A screenshot with no case and no recent report to attach it to: ask for
      // the one line that makes it actionable instead of guessing.
      case "image_need_context":
        return "ได้รับรูปแล้วนะคะ รบกวนพิมพ์อธิบายอาการสั้น ๆ อีกนิดค่ะ จะได้เปิดเคสให้ถูกต้องนะคะ";
      case "ticket_created":
        return ticketNumber
          ? `สร้างเคส #${ticketNumber} ให้แล้วนะคะ ทีมงานกำลังตรวจสอบให้อยู่ค่ะ`
          : "สร้างเคสให้แล้วนะคะ ทีมงานกำลังตรวจสอบให้อยู่ค่ะ";
      case "resolution_confirmation":
        return ticketNumber
          ? `เคส #${ticketNumber} ตรวจสอบและแก้ไขปัญหาเรียบร้อยแล้วค่ะ รบกวนลองใช้งานอีกครั้งนะคะ หากใช้งานได้แล้วแจ้งยืนยันเพื่อปิดเคสได้เลยค่ะ`
          : "ตรวจสอบและแก้ไขปัญหาเรียบร้อยแล้วค่ะ รบกวนลองใช้งานอีกครั้งนะคะ หากใช้งานได้แล้วแจ้งยืนยันเพื่อปิดเคสได้เลยค่ะ";
      case "closed":
        return ticketNumber
          ? `ปิดเคส #${ticketNumber} เรียบร้อยแล้วนะคะ ขอบคุณที่แจ้งเข้ามาค่ะ`
          : "ปิดเคสเรียบร้อยแล้วนะคะ ขอบคุณที่แจ้งเข้ามาค่ะ";
      case "reopened":
        return ticketNumber
          ? `เปิดเคส #${ticketNumber} ขึ้นมาตรวจสอบอีกครั้งแล้วนะคะ ทีมงานกำลังดูให้อยู่ค่ะ`
          : "เปิดเคสขึ้นมาตรวจสอบอีกครั้งแล้วนะคะ ทีมงานกำลังดูให้อยู่ค่ะ";
    }
  }

  /**
   * Resolves the LINE user id and tenant for a conversation.
   * Returns null when the conversation has no LINE identity, in which case
   * nothing is sent rather than guessing a recipient.
   */
  private async resolveRecipient(conversationId: number): Promise<{
    recipientRef: string;
    channel: string;
    projectId: number | null;
    orgId: string | null;
  } | null> {
    const { rows } = await pool.query(
      `SELECT i.channel_ref, c.channel, c.project_id, c.org_id
         FROM conversations c
         JOIN identities i ON c.identity_id = i.id
        WHERE c.id = $1 AND c.deleted_at IS NULL
        LIMIT 1`,
      [conversationId]
    );
    if (rows.length === 0 || !rows[0].channel_ref) return null;
    return {
      recipientRef: String(rows[0].channel_ref),
      channel: String(rows[0].channel || "line").toLowerCase(),
      projectId: rows[0].project_id ?? null,
      orgId: rows[0].org_id ?? null,
    };
  }

  /**
   * Claims the notification row.
   *
   * Returns false when the unique index rejects it, which means this exact
   * notification was already sent (or is being sent right now). Claiming
   * before sending is what makes concurrent senders safe.
   */
  private async claim(req: SendRequest, recipientRef: string, channel: string, body: string): Promise<number | null> {
    const { rows } = await pool.query(
      `INSERT INTO customer_notifications
         (conversation_id, ticket_id, project_id, org_id, notification_type,
          idempotency_key, channel, recipient_ref, status, body, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)
       ON CONFLICT (notification_type, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        req.conversationId,
        req.ticketId ?? null,
        req.projectId ?? null,
        req.orgId ?? null,
        req.notificationType,
        req.idempotencyKey,
        channel,
        recipientRef,
        body,
        req.correlationId ?? null,
      ]
    );
    return rows.length > 0 ? Number(rows[0].id) : null;
  }

  private async markSent(id: number): Promise<void> {
    await pool
      .query(`UPDATE customer_notifications SET status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $1`, [id])
      .catch((err) => logger.warn({ error: err.message, id }, "Could not mark notification sent"));
  }

  private async markFailed(id: number, error: string): Promise<void> {
    await pool
      .query(
        `UPDATE customer_notifications SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1`,
        [id, error.slice(0, 500)]
      )
      .catch(() => {});
  }

  /** Pushes a LINE message. Never logs the access token. */
  private async pushLine(recipientRef: string, text: string): Promise<void> {
    const token = (config.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
    if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");

    await axios.post(
      "https://api.line.me/v2/bot/message/push",
      { to: recipientRef, messages: [{ type: "text", text }] },
      { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
  }

  /**
   * Sends a customer notification at most once.
   *
   * The message is recorded in the conversation regardless of delivery, so an
   * operator can see what the customer was told even if LINE was unreachable.
   */
  async send(req: SendRequest): Promise<SendResult> {
    const recipient = await this.resolveRecipient(req.conversationId);
    if (!recipient) {
      logger.warn({ conversationId: req.conversationId }, "No recipient for conversation; notification suppressed");
      return { sent: false, reason: "NO_RECIPIENT" };
    }

    // One acknowledgement per burst, not per message. Idempotency is keyed on
    // the LINE event, so a customer sending "แจ้งเคสค่ะ", then the details, then
    // a screenshot used to receive three of these — and now that the wording is
    // randomized they would not even look like the same message.
    if (req.notificationType === "acknowledgement" || req.notificationType === "acknowledgement_action") {
      const recent = await pool.query(
        `SELECT 1 FROM customer_notifications
          WHERE conversation_id = $1
            AND notification_type IN ('acknowledgement', 'acknowledgement_action')
            AND created_at >= NOW() - ($2::int * INTERVAL '1 second')
          LIMIT 1`,
        [req.conversationId, ACK_BURST_WINDOW_SECONDS]
      );
      if (recent.rows.length > 0) {
        logger.info(
          { conversationId: req.conversationId, idempotencyKey: req.idempotencyKey },
          "Acknowledgement suppressed: one was already sent for this burst"
        );
        return { sent: false, duplicate: true, reason: "RECENTLY_ACKNOWLEDGED" };
      }
    }

    const body = this.body(req.notificationType, req.ticketNumber, req.idempotencyKey, req.subject);

    const claimId = await this.claim(
      { ...req, projectId: req.projectId ?? recipient.projectId, orgId: req.orgId ?? recipient.orgId },
      recipient.recipientRef,
      recipient.channel,
      body
    );

    if (claimId === null) {
      logger.info(
        { conversationId: req.conversationId, type: req.notificationType, idempotencyKey: req.idempotencyKey },
        "Customer notification already sent for this event; suppressing duplicate"
      );
      return { sent: false, duplicate: true, reason: "ALREADY_SENT", body };
    }

    try {
      if (recipient.channel === "line") {
        await this.pushLine(recipient.recipientRef, body);
      } else {
        // Other channels deliver through their own gateway; the ledger row
        // and the conversation record are still written.
        logger.info({ channel: recipient.channel }, "Non-LINE channel: notification recorded, delivery delegated");
      }

      await this.markSent(claimId);
      await this.appendToConversation(req.conversationId, body);

      await traceRecorder.record({
        correlationId: req.correlationId || `notify-${claimId}`,
        component: "notification",
        eventType: `${req.notificationType}_sent`,
        conversationId: req.conversationId,
        ticketId: req.ticketId ?? null,
        projectId: req.projectId ?? recipient.projectId ?? null,
        orgId: req.orgId ?? recipient.orgId ?? null,
        detail: { channel: recipient.channel, notificationId: claimId, ticketNumber: req.ticketNumber ?? null },
      });

      logger.info(
        {
          conversationId: req.conversationId,
          ticketId: req.ticketId ?? null,
          type: req.notificationType,
          notificationId: claimId,
          correlationId: req.correlationId ?? null,
        },
        "Customer notification sent"
      );
      return { sent: true, body };
    } catch (err: any) {
      await this.markFailed(claimId, err.message);
      await traceRecorder.record({
        correlationId: req.correlationId || `notify-${claimId}`,
        component: "notification",
        eventType: `${req.notificationType}_failed`,
        status: "failed",
        conversationId: req.conversationId,
        ticketId: req.ticketId ?? null,
        errorMessage: err.message,
      });
      // Still record what we intended to say, so the thread is not silently
      // missing a turn the customer may or may not have received.
      await this.appendToConversation(req.conversationId, body);
      logger.error(
        { conversationId: req.conversationId, type: req.notificationType, error: err.message },
        "Customer notification delivery failed"
      );
      return { sent: false, reason: "DELIVERY_FAILED", body };
    }
  }

  private async appendToConversation(conversationId: number, text: string): Promise<void> {
    await pool
      .query(
        `INSERT INTO messages (conversation_id, role, content, message_type, message_purpose, created_at)
         VALUES ($1, 'ai', $2, 'text', 'notification', NOW())`,
        [conversationId, text]
      )
      .catch((err) => logger.warn({ error: err.message, conversationId }, "Could not append notification to conversation"));
  }
}

export const customerNotificationService = new CustomerNotificationService();
