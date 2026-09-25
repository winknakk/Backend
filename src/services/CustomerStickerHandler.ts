/**
 * A customer sent a LINE sticker (2026-09-24). Answered at the edge, never by
 * the AI:
 *   - a question is pending (close / cancel / re-open / delivery): a PLEASE
 *     sticker and a reminder that re-attaches its chips — the sticker itself
 *     is never taken as the answer;
 *   - nothing pending: a sticker back, picked from the mood LINE's keywords
 *     suggest (an annoyed customer also gets one line inviting them to type);
 *   - a staff member owns the chat, or stickers are disabled: silence.
 * The customer's sticker is always written to `messages` for the admin view.
 */
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";
import { customerConfirmationHandler } from "./CustomerConfirmationHandler";
import { customerNotificationService } from "./CustomerNotificationService";
import { ANGRY_FOLLOW_UP, MOOD_STICKERS, classifyStickerMood, customerStickerRecord, type StickerMood } from "./LineStickers";

const logger = createLogger("customer-sticker");

export interface CustomerStickerInput {
  conversationId: number;
  projectId?: number | null;
  /** LINE webhook event id: the idempotency key of the answer. */
  eventId: string;
  messageId?: string | null;
  quoteToken?: string | null;
  keywords?: unknown;
  text?: unknown;
}

export type CustomerStickerOutcome =
  | { answer: "reminder" }
  | { answer: "sticker"; mood: StickerMood }
  | { answer: "silent"; reason: string };

export async function answerCustomerSticker(input: CustomerStickerInput): Promise<CustomerStickerOutcome> {
  await pool
    .query(
      `INSERT INTO messages (conversation_id, role, content, message_type, external_id, quote_token, created_at)
       VALUES ($1, 'customer', $2, 'sticker', $3, $4, NOW())
       ON CONFLICT (conversation_id, external_id) DO NOTHING`,
      [input.conversationId, customerStickerRecord(input.keywords, input.text), String(input.messageId || input.eventId), input.quoteToken ?? null]
    )
    .catch((err) => logger.warn({ error: err.message, conversationId: input.conversationId }, "Could not record customer sticker"));

  if (!config.LINE_STICKERS_ENABLED) return { answer: "silent", reason: "DISABLED" };

  const owner = await pool
    .query<{ ai_owned: boolean }>(
      `SELECT COALESCE(LOWER(handled_by), 'ai') = 'ai' AND COALESCE(LOWER(takeover_state), 'none') = 'none' AS ai_owned
         FROM conversations WHERE id = $1`,
      [input.conversationId]
    )
    .then((r) => r.rows[0]?.ai_owned !== false)
    .catch(() => false);
  if (!owner) return { answer: "silent", reason: "STAFF_OWNS_CHAT" };

  const base = {
    conversationId: input.conversationId,
    idempotencyKey: input.eventId,
    projectId: input.projectId ?? null,
    correlationId: input.eventId,
  };

  const chips = await customerConfirmationHandler.pendingReminderChips(input.conversationId);
  if (chips) {
    if (chips.length === 0) return { answer: "silent", reason: "PENDING_WITHOUT_CHIPS" };
    await customerNotificationService.send({ ...base, notificationType: "sticker_reminder", quickReplies: chips });
    return { answer: "reminder" };
  }

  const mood = classifyStickerMood(input.keywords, input.text);
  const r = await customerNotificationService.send({
    ...base,
    notificationType: "sticker_reply",
    sticker: MOOD_STICKERS[mood],
    detail: mood === "angry" ? ANGRY_FOLLOW_UP : null,
    quickReplies: [],
  });
  return r.sent ? { answer: "sticker", mood } : { answer: "silent", reason: r.reason || "NOT_SENT" };
}
