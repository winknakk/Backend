/**
 * LINE voice messages (2026-09-28). A voice clip becomes text at the edge and
 * then takes the ordinary text path, so the AI flows never see audio:
 *
 *   LINE audio event → download (api-data.line.me, the clip expires quickly)
 *     → original kept in media storage for the admin view
 *     → "Backend - Voice Transcription Flow" (/sync webhook → OpenAI
 *       Transcribe Audio, Thai) → { text }
 *     → messages row, message_type 'audio', content = transcript
 *
 * Off until PROMPTX_TRANSCRIBE_WEBHOOK_URL is set; lineWebhook then keeps
 * answering voice clips with the "unsupported file" notice.
 *
 * Voice never answers a pending question: a mis-heard "ใช่" must not close a
 * case. `typedAnswerRequired` decides when the customer is asked to tap or type.
 */
import axios from "axios";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";
import { detectCancelIntent, detectCloseIntent, detectReopenConfirmation } from "../domain/ticket/CustomerConfirmation";
import { customerConfirmationHandler } from "./CustomerConfirmationHandler";
import type { NotificationQuickReply } from "./CustomerNotificationService";

const logger = createLogger("voice-transcription");

export type VoiceTranscriptionOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: "TOO_LONG" | "EMPTY" | "FAILED" };

export interface LineVoiceInput {
  conversationId: number;
  projectId?: number | null;
  /** LINE message id: the content id and the messages.external_id. */
  messageId: string;
  /** LINE `message.duration`, milliseconds. */
  durationMs?: number | null;
  quoteToken?: string | null;
  correlationId?: string;
}

/**
 * The engine's data-URI parser only accepts a mime of letters, "-", "+" and
 * "/" (activepieces engine `processors/file.ts`), so LINE's `audio/x-m4a`
 * would be dropped. `audio/mpeg` passes and names the file `.mpga`, a format
 * OpenAI accepts; the service reads the container itself.
 */
const DATA_URI_MIME = "audio/mpeg";

/**
 * What Whisper writes for silence or noise. Taken as "nothing was said" so a
 * blank clip is never forwarded to the AI as a customer message.
 */
const SILENCE_HALLUCINATIONS =
  /^[\s.。!?]*(?:ขอบคุณที่รับชม|ขอบคุณที่ติดตาม|ติดตามชมตอนต่อไป|กดติดตาม|thank you for watching|thanks for watching|subtitles by)[^\n]{0,40}$/i;

export function isSilenceTranscript(text: string): boolean {
  const t = String(text || "").trim();
  return t === "" || SILENCE_HALLUCINATIONS.test(t);
}

/** The flow returns `{ text }`; tolerate the OpenAI body passed through whole or nested. */
export function parseTranscriptResponse(data: unknown): string {
  if (typeof data === "string") return data.trim();
  const d = (data ?? {}) as Record<string, any>;
  const text = d.text ?? d.transcript ?? d.body?.text ?? d.data?.text ?? "";
  return typeof text === "string" ? text.trim() : "";
}

/**
 * Whether a transcript must not reach the confirmation handler. Returns the
 * chips to re-attach (possibly []) or null when the transcript may proceed.
 *
 * - a question with rebuildable chips is pending → its chips;
 * - the transcript itself is an explicit confirmation (ยืนยันปิดเคส /
 *   ยืนยันยกเลิกเคส / ยืนยันเปิดเคสอีกครั้ง) → [] — asked to type or tap instead.
 * Requests ("ปิดเคส", "ยกเลิกเคส TCK-…") still pass: they only produce a
 * question with chips.
 */
export function typedAnswerDecision(transcript: string, pendingChips: NotificationQuickReply[] | null): NotificationQuickReply[] | null {
  if (pendingChips && pendingChips.length > 0) return pendingChips;
  if (detectCloseIntent(transcript, false).kind === "CONFIRM_CLOSE") return [];
  if (detectCancelIntent(transcript, false).kind === "CONFIRM_CANCEL") return [];
  if (detectReopenConfirmation(transcript).confirmed) return [];
  return null;
}

export class VoiceTranscriptionService {
  isEnabled(): boolean {
    return Boolean(config.PROMPTX_TRANSCRIBE_WEBHOOK_URL);
  }

  async typedAnswerRequired(conversationId: number, transcript: string): Promise<NotificationQuickReply[] | null> {
    let chips: NotificationQuickReply[] | null = null;
    try {
      chips = await customerConfirmationHandler.pendingReminderChips(conversationId);
    } catch (err: any) {
      logger.warn({ conversationId, error: err.message }, "Could not read the pending question; applying the explicit-confirmation rule only");
    }
    return typedAnswerDecision(transcript, chips);
  }

  async transcribeLineVoice(input: LineVoiceInput): Promise<VoiceTranscriptionOutcome> {
    if (input.durationMs && input.durationMs > config.VOICE_MAX_SECONDS * 1000) {
      await this.persist(input, "", null);
      return { ok: false, reason: "TOO_LONG" };
    }

    let audio: { buffer: Buffer; mimeType: string };
    try {
      const { LINEAdapter } = await import("../presentation/http/adapters/LINEAdapter");
      const { S3MediaStorageService } = await import("../media/services/S3MediaStorageService");
      const storage = new S3MediaStorageService({});
      const adapter = new LINEAdapter(storage, (config.LINE_CHANNEL_ACCESS_TOKEN || "").trim());
      audio = await adapter.downloadLINEContent(input.messageId);

      // The original clip is for the admin view only; failing to store it
      // must not cost the customer their message.
      let stored = null;
      try {
        stored = await storage.upload({
          buffer: audio.buffer,
          fileName: `line_audio_${input.messageId}.m4a`,
          mimeType: audio.mimeType || "audio/x-m4a",
          folder: "line_media",
        });
      } catch (storeErr: any) {
        logger.warn({ messageId: input.messageId, error: storeErr.message }, "Could not store the voice clip; transcribing anyway");
      }
      await this.persist(input, "", stored);
    } catch (dlErr: any) {
      logger.error({ messageId: input.messageId, error: dlErr.message }, "Could not download the LINE voice clip");
      return { ok: false, reason: "FAILED" };
    }

    let text = "";
    try {
      const response = await axios.post(
        String(config.PROMPTX_TRANSCRIBE_WEBHOOK_URL),
        {
          audio_file: `data:${DATA_URI_MIME};base64,${audio.buffer.toString("base64")}`,
          source_mime_type: audio.mimeType,
          duration_ms: input.durationMs ?? null,
          conversation_id: input.conversationId,
          project_id: input.projectId ?? null,
          correlation_id: input.correlationId ?? null,
        },
        { headers: { "Content-Type": "application/json" }, timeout: config.VOICE_TRANSCRIBE_TIMEOUT_MS, maxBodyLength: Infinity }
      );
      text = parseTranscriptResponse(response.data);
    } catch (err: any) {
      logger.error(
        { messageId: input.messageId, status: err.response?.status, error: err.message },
        "Voice transcription flow failed"
      );
      return { ok: false, reason: "FAILED" };
    }

    if (isSilenceTranscript(text)) {
      logger.info({ messageId: input.messageId, text }, "Voice clip transcribed to nothing usable");
      return { ok: false, reason: "EMPTY" };
    }
    await this.persist(input, text, null);
    logger.info({ messageId: input.messageId, conversationId: input.conversationId, chars: text.length }, "Voice clip transcribed");
    return { ok: true, text };
  }

  /**
   * One `messages` row per clip (message_type 'audio', idempotent on the LINE
   * message id), its content filled once the transcript is known, and the
   * stored clip as its attachment. The text path's own insert later hits the
   * same (conversation_id, external_id) and only rewrites the content.
   */
  private async persist(
    input: LineVoiceInput,
    content: string,
    stored: { fileUrl: string; fileName: string; fileType: string; fileSize: number; storageKey: string } | null
  ): Promise<void> {
    try {
      const saved = await pool.query<{ id: number }>(
        `INSERT INTO messages (conversation_id, role, content, message_type, external_id, quote_token, created_at)
         VALUES ($1, 'customer', $2, 'audio', $3, $4, NOW())
         ON CONFLICT (conversation_id, external_id) DO UPDATE SET
           message_type = 'audio',
           content = CASE WHEN EXCLUDED.content <> '' THEN EXCLUDED.content ELSE messages.content END
         RETURNING id`,
        [input.conversationId, content, input.messageId, input.quoteToken ?? null]
      );
      const messageId = saved.rows[0]?.id;
      if (messageId && stored) {
        await pool.query(
          `INSERT INTO message_attachments
             (message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata)
           VALUES ($1, $2, NULL, $3, $4, $5, $6, 'READY', $7)
           ON CONFLICT DO NOTHING`,
          [
            messageId,
            stored.fileUrl,
            stored.fileName,
            stored.fileType,
            stored.fileSize,
            stored.storageKey,
            JSON.stringify({ sourceChannel: "line", lineMessageId: input.messageId, durationMs: input.durationMs ?? null }),
          ]
        );
      }
    } catch (err: any) {
      logger.error({ messageId: input.messageId, error: err.message }, "Could not persist the voice message");
    }
  }
}

export const voiceTranscriptionService = new VoiceTranscriptionService();
