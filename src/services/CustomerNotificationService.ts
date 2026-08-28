import axios from "axios";
import { createHash } from "crypto";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";
import { traceRecorder } from "../observability/TraceRecorder";

const logger = createLogger("customer-notification");

export type CustomerNotificationType =
  | "acknowledgement"
  | "greeting"
  | "thanks"
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
}

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
    "รับเรื่องค่ะ เดี๋ยวรีบดูให้เลยนะคะ",
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
  private body(type: CustomerNotificationType, ticketNumber?: string | null, seed?: string | null): string {
    switch (type) {
      case "acknowledgement":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.ACK_VARIANTS, seed);
      case "greeting":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.GREETING_VARIANTS, seed);
      case "thanks":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.THANKS_VARIANTS, seed);
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

    const body = this.body(req.notificationType, req.ticketNumber, req.idempotencyKey);

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
