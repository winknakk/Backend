import axios from "axios";
import { createHash } from "crypto";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";
import { traceRecorder } from "../observability/TraceRecorder";
import Redis from "ioredis";
import { createRedisClient } from "../infrastructure/cache/createRedisClient";
import { broadcastWebChatOutbound } from "../presentation/http/routes/WebChatGateway";
import {
  NOTIFICATION_STICKERS,
  STICKER_MIN_INTERVAL_MINUTES,
  THROTTLED_STICKER_TYPES,
  stickerMessage,
  stickerRecord,
  type LineSticker,
} from "./LineStickers";

const logger = createLogger("customer-notification");

export type CustomerNotificationType =
  | "acknowledgement"
  | "acknowledgement_action"
  // The "ขอแก้ไขข้อมูล" chip and the correction that answers it (2026-09-17).
  | "acknowledgement_edit"
  // A chip answer / protocol word the edge could not settle itself ("ยังไม่ปิด"
  // with no question pending): a plain receipt, never "แอดมินดูให้" (2026-09-24).
  | "acknowledgement_choice"
  | "greeting"
  | "thanks"
  | "image_attached"
  | "image_confirm_case"
  | "image_which_case"
  | "image_case_not_found"
  | "image_need_context"
  // A standalone screenshot attached to the case just opened without asking
  // (LINE_IMAGE_AUTO_ATTACH_MINUTES, operator decision 2026-09-17).
  | "image_auto_attached"
  | "image_auto_attach_pending"
  | "unsupported_file"
  | "ticket_created"
  | "resolution_confirmation"
  | "closed"
  | "reopened"
  | "progress_update"
  // Two-step close (2026-09-07).
  | "close_confirmation_request"
  | "close_declined"
  | "close_no_open_case"
  | "close_which_case"
  | "resolution_nudge"
  // Several delivered cases and an answer that names none (H1, 2026-09-24).
  | "resolution_which_case"
  // A customer action whose state transition was refused (H6, 2026-09-24).
  | "action_failed"
  | "auto_closed"
  // Re-open path (2026-09-08).
  | "reopen_which_kind"
  | "reopen_feedback_saved"
  | "reopen_new_issue_prompt"
  | "reopened_by_team"
  | "reopen_too_old"
  | "reopen_confirmation_request"
  | "due_extension_notice"
  // Engineering set "Waiting for Customer" in Plane (2026-09-10).
  | "waiting_customer"
  // Post-ticket cancel, two-step (Flow 5, 2026-09-17).
  | "cancel_confirmation_request"
  | "cancelled"
  | "cancel_declined"
  | "cancel_which_case"
  | "cancel_no_open_case"
  | "cancel_case_not_open"
  // Multi-case context answered at the edge on LINE (Flow 6, 2026-09-17):
  // the resolver's own clarification text, chips supplied by the caller.
  | "case_context"
  // The [เปิดเคสใหม่จากเรื่องนี้] chip / a bare "เปิดเคสใหม่" (2026-09-18): ask for
  // the report instead of letting the AI file the chip text as the subject.
  | "follow_up_prompt"
  | "new_case_prompt"
  // The "แจ้งปัญหา" menu card's reply, recorded by lineWebhook (never sent through send()).
  | "report_prompt"
  // AI timeout fallback (AD-14): informs customer when AI reply takes longer than expected.
  | "ai_timeout_fallback"
  // A customer sent a LINE sticker (2026-09-24): a sticker back (sticker_reply),
  // or, while a question is pending, a nudge that re-attaches its chips.
  | "sticker_reply"
  | "sticker_reminder";

/**
 * Facts the case card is built from. Loaded from `tickets` by ticket id when
 * the caller does not supply them.
 */
export interface CaseFacts {
  status?: string | null;
  subject?: string | null;
  createdAt?: Date | string | null;
  dueAt?: Date | string | null;
  resolvedAt?: Date | string | null;
}

/**
 * "09/09/69 เวลา 13:04 น." — Bangkok wall clock, zero-padded day / month /
 * hour / minute, two-digit Buddhist year (operator decision 2026-09-10: never
 * "วันนี้" or "พรุ่งนี้", always the date). Asia/Bangkok is UTC+7 all year.
 */
export function thaiDateStamp(value: Date | string | null | undefined): string {
  const d = value instanceof Date ? value : new Date(String(value || ""));
  if (!value || isNaN(d.getTime())) return "";
  const b = new Date(d.getTime() + 7 * 3_600_000);
  const pad = (x: number) => (x < 10 ? `0${x}` : String(x));
  const yy = pad((b.getUTCFullYear() + 543) % 100);
  return `${pad(b.getUTCDate())}/${pad(b.getUTCMonth() + 1)}/${yy} เวลา ${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())} น.`;
}

/**
 * The status word on the "• สถานะ:" line. Plane keeps its own vocabulary;
 * the customer sees six coarse states (operator decision 2026-09-10:
 * TRIAGED and IN_PROGRESS read the same).
 */
export function customerStatusLabel(status: string | null | undefined): string {
  switch (String(status || "").trim().toUpperCase().replace(/[\s-]+/g, "_")) {
    case "NEW":
    case "OPEN":
    case "BACKLOG":
    case "TODO":
      return "รับเรื่องแล้ว";
    case "TRIAGED":
    case "IN_PROGRESS":
    case "WAITING_INTERNAL":
      return "อยู่ระหว่างดำเนินการ";
    case "REOPENED":
      return "เปิดเคสอีกครั้ง อยู่ระหว่างตรวจสอบซ้ำ";
    case "WAITING_CUSTOMER":
      return "รอข้อมูลเพิ่มเติมจากคุณลูกค้า";
    case "RESOLVED":
    case "CUSTOMER_CONFIRMED":
      return "แก้ไขแล้ว รอคุณลูกค้าตรวจสอบ";
    case "CLOSED":
    case "DONE":
      return "เสร็จสิ้น";
    case "CANCELLED":
      return "ยกเลิกแล้ว";
    default:
      return "อยู่ระหว่างดำเนินการ";
  }
}

/** LINE quick-reply chip (message action): the tap sends `text` as the customer. */
export interface NotificationQuickReply {
  label: string;
  text: string;
}

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
  /**
   * Optional case subject: the "เรื่อง" bullet of progress / delivery
   * messages, and the case named when asking which case an image belongs to.
   */
  subject?: string | null;
  /**
   * Extra plain-Thai text merged into the body. For progress_update it is the
   * pre-formatted bullet lines (status, target time, reported-at) built by the
   * SLA cadence engine. Never internal vocabulary.
   */
  detail?: string | null;
  /**
   * Facts for the case card (progress / delivery / waiting / closed). When
   * omitted and `ticketId` is set, they are read from `tickets`.
   */
  facts?: CaseFacts | null;
  /**
   * Quick-reply chips. When omitted, the type's default chips are attached
   * (delivery / close question); pass [] to send none.
   */
  quickReplies?: NotificationQuickReply[] | null;
  /**
   * LINE sticker sent before the text. When omitted, the type's sticker from
   * NOTIFICATION_STICKERS is used; pass null to send none.
   */
  sticker?: LineSticker | null;
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
   * Acknowledgement for the "ขอแก้ไขข้อมูล" chip and for the correction the
   * customer types after the "which part to change?" question (operator
   * request 2026-09-17: the general "ขอแอดมินดูสักครู่" line read oddly as a
   * reply to a tap). Short, promises only a moment's wait, never mentions a
   * ticket. Picked per LINE event id like the other variants, so consecutive
   * taps differ while a webhook retry cannot re-word the same one.
   */
  private static readonly ACK_EDIT_VARIANTS = [
    "รับทราบค่ะ รอสักครู่นะคะ",
    "ได้เลยค่ะ รอแป๊บนึงนะคะ",
    "รับทราบค่ะ ขอเวลาสักครู่นะคะ",
    "โอเคค่ะ รอสักครู่นะคะ",
    "ได้ค่ะ ขอเวลาแป๊บนึงนะคะ",
    "รับทราบค่ะ แป๊บนึงนะคะ",
    "ได้เลยค่ะ สักครู่นะคะ",
  ] as const;

  /**
   * Receipt for a chip answer or protocol word that reaches the AI ("ยังไม่ปิด"
   * with no close question pending, "ตรวจสอบสถานะ"). The customer pressed a
   * choice, so the line only confirms it was heard — no "แอดมินดูให้", no
   * promise of a person looking (operator request 2026-09-24).
   */
  private static readonly ACK_CHOICE_VARIANTS = [
    "รับทราบค่ะ",
    "ได้เลยค่ะ รับทราบนะคะ",
    "โอเคค่ะ รับทราบค่ะ",
    "รับทราบตามนี้เลยค่ะ",
    "ได้ค่ะ รับทราบแล้วนะคะ",
    "เข้าใจแล้วค่ะ ขอบคุณนะคะ",
    "รับทราบค่ะ ขอบคุณที่แจ้งนะคะ",
  ] as const;

  /** "Which delivered case?" — the list follows; each chip names one case. */
  private static readonly RESOLUTION_WHICH_CASE_VARIANTS = [
    "ตอนนี้มีหลายเคสที่ทีมงานแก้ไขแล้วและรอคุณลูกค้าทดสอบอยู่ค่ะ หมายถึงเคสไหนคะ",
    "มีมากกว่าหนึ่งเคสที่รอคุณลูกค้าทดสอบอยู่นะคะ รบกวนเลือกเคสที่หมายถึงจากรายการนี้ได้เลยค่ะ",
  ] as const;

  /** A refused transition: say it did not happen, promise nothing else. */
  private static readonly ACTION_FAILED_VARIANTS = [
    "ขออภัยค่ะ ตอนนี้ยังทำรายการกับเคส {ticket} ไม่สำเร็จ รบกวนลองใหม่อีกครั้งในอีกสักครู่นะคะ",
    "ขออภัยนะคะ ระบบยังเปลี่ยนสถานะเคส {ticket} ไม่สำเร็จ รบกวนลองอีกครั้งในอีกสักครู่ค่ะ",
  ] as const;

  /**
   * Chip texts and protocol words (2026-09-24): a turn made of one of these
   * is a choice, acknowledged with ACK_CHOICE_VARIANTS when it reaches the AI.
   */
  private static readonly CHOICE_TURN_RE =
    /^\s*(?:ยังไม่(?:ต้อง)?ปิด|อย่าเพิ่งปิด|ไม่(?:ต้อง)?ปิด|ยังไม่ยกเลิก|ไม่(?:ต้อง)?ยกเลิก|ยืนยันปิดเคส|ยืนยันยกเลิกเคส|ยืนยันเปิดเคส(?:อีกครั้ง)?|ปัญหาเดิม|ปัญหาใหม่|ใช้งานได้แล้ว|ยังมีปัญหาอยู่|สลับไปที่|ปิดเคส|ยกเลิกเคส|ดูเคสล่าสุดทั้งหมด|ตรวจสอบสถานะ|ขอคุยกับเจ้าหน้าที่)(?:\s*(?:เคส)?\s*TCK-\d{4}-\d{4,6})?[\s.,!]*(?:ค่ะ|คะ|ครับ|คับ|จ้า|นะคะ|นะครับ)?\s*$/i;

  /**
   * Which Fast Ack a LINE text turn gets. Order: the edit chip, a choice
   * (chip text), a short action word, a correction to a pending draft, else
   * the general receipt.
   */
  static classifyAcknowledgement(
    msgText: string,
    pendingIntake?: string | null
  ): "acknowledgement" | "acknowledgement_action" | "acknowledgement_edit" | "acknowledgement_choice" {
    const text = String(msgText || "").trim();
    if (/^\s*ขอแก้ไขข้อมูล\s*$/.test(text)) return "acknowledgement_edit";
    if (CustomerNotificationService.CHOICE_TURN_RE.test(text)) return "acknowledgement_choice";
    // A bag of particle characters (moved unchanged from lineWebhook, where it
    // already tripped this rule); Thai tone marks in a class are intended here.
    const tailPattern = "(?:[\\s.,!ๆ555คะครับค่ะคับค้าบคร้าบจ้าจ้ะงับฮะฮับนะน้าอ้วนผมวะอ่ะแอดมินพี่คุณ]*)$";
    const isActionTurn =
      // eslint-disable-next-line no-misleading-character-class
      new RegExp(`^(?:ครับ|ค่ะ|คับ|ค้าบ|คร้าบ|ค่า|ค๊า|ฮับ|ฮะ|งับ|จ้า|จ้ะ|จร้า|อือ|อื้อ|เค|k|ok|yes|yup|yep|sure|confirm|จัดไป|ลุย|ลุยเลย|เอาเลย|ตามนั้น|เปิดเลย|เปิดเคสเลย|จัดการเลย|จัดให้หน่อย|ถูก|ถูกต้อง|ถูกแล้ว|ใช่|ใช่เลย|ใช่แล้ว|ช่าย|โอเค|ได้|ได้เลย|ได้หมด|ยกเลิก|cancel|ไม่เอา|ไม่ต้อง|ไม่แจ้ง|ช่างมัน|แก้ได้แล้ว|ทำได้แล้ว|หายแล้ว|รีเซ็ต|reset|พิมพ์ผิด|เปลี่ยนใจ|ไม่เป็นไร|อย่าเพิ่ง|no|nope|❌|👍|✅)${tailPattern}`, "i").test(text) ||
      /(?:ยืนยัน|ถูกต้อง|ถูกแล้ว|ใช่เลย|โอเค|ได้เลย|เปิดเคสเลย|จัดไป|ตามนั้น|ส่งรูป|นี่รูป|รูปปัญหา|ภาพปัญหา|แนบรูป|ยกเลิก|cancel|ไม่เอาแล้ว|ไม่ต้องแล้ว|ไม่แจ้งแล้ว|ช่างมัน|แก้ได้แล้ว|ทำได้แล้ว|รีเซ็ต|reset|พิมพ์ผิด|เปลี่ยนใจ|ไม่เป็นไรแล้ว|อย่าเพิ่งเปิด)/i.test(text) ||
      /(?:^|\s|[.,!])(?:ใช่|ถูก|โอเค|ok|ได้|ครับ|ค่ะ|คับ|งับ|ฮะ|จ้า|เค|ยกเลิก|ไม่เอา|ไม่ต้อง)/i.test(text);
    if (isActionTurn) return "acknowledgement_action";
    if (pendingIntake === "edit") return "acknowledgement_edit";
    return "acknowledgement";
  }

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

  /**
   * AI timeout fallback (AD-14): informs customer when AI reply takes longer than expected,
   * with action chips to track status or request human assistance without duplicating tickets.
   */
  private static readonly AI_TIMEOUT_FALLBACK_VARIANTS = [
    "ขออภัยด้วยนะคะ ขณะนี้ระบบ AI ใช้เวลาประมวลผลนานกว่าปกติ คุณลูกค้าสามารถแตะตรวจสอบสถานะ หรือเลือกติดต่อเจ้าหน้าที่ได้เลยค่ะ",
    "ขออภัยในความล่าช้านะคะ ขณะนี้ระบบกำลังเร่งประมวลผลข้อมูล สามารถแตะปุ่มด้านล่างเพื่อตรวจสอบสถานะเคสได้เลยนะคะ",
  ] as const;

  /**
   * Case card (operator decision 2026-09-10). Every status message the
   * customer receives has the same shape, so it is recognised at a glance:
   *
   *   เคส TCK-…
   *
   *   • เรื่อง: <subject>
   *   • สถานะ: <customerStatusLabel>
   *   • แจ้งเมื่อ: <created_at>
   *
   *   <closing line(s)>
   *
   * No opener, no rotating closer — only the close message keeps a random
   * thank-you line. LINE renders "\n" and "•" as-is.
   */
  private static caseBlock(ticketNumber: string | null | undefined, facts: CaseFacts | null | undefined, statusLabel: string, closing: string): string {
    const subject = CustomerNotificationService.subjectLine(facts?.subject);
    const created = thaiDateStamp(facts?.createdAt);
    const bullets = [
      ...(subject ? [`• เรื่อง: ${subject}`] : []),
      `• สถานะ: ${statusLabel}`,
      ...(created ? [`• แจ้งเมื่อ: ${created}`] : []),
    ];
    return [`เคส ${ticketNumber || "ที่แจ้งไว้"}`, bullets.join("\n"), closing.trim()].filter((part) => part.length > 0).join("\n\n");
  }

  /** A due date this far out is the "no resolution target" sentinel (priority None = 999 h in the Hub), not a promise. */
  private static readonly NO_TARGET_DAYS = 40;

  /** "คาดว่าเรียบร้อย <due>" while the target is ahead; otherwise the still-working line. */
  private static dueLine(facts: CaseFacts | null | undefined): string {
    const due = facts?.dueAt instanceof Date ? facts.dueAt : facts?.dueAt ? new Date(String(facts.dueAt)) : null;
    if (due && !isNaN(due.getTime())) {
      const ahead = due.getTime() - Date.now();
      if (ahead > CustomerNotificationService.NO_TARGET_DAYS * 86_400_000) return "ทีมงานรับเรื่องไว้แล้ว จะแจ้งกำหนดการให้ทราบอีกครั้งค่ะ";
      if (ahead > 0) return `คาดว่าเรียบร้อย ${thaiDateStamp(due)}`;
    }
    return "ทีมงานกำลังเร่งดำเนินการให้โดยเร็วที่สุดค่ะ";
  }

  /**
   * Two-step close wording. Every variant names the case number without "#"
   * (operator decision) and, where the subject is known, the subject in
   * quotes. None of them contains the phrases the AI gate's create-
   * confirmation net keys on ("ปุ่มด้านล่าง", "กดปุ่ม 'ยืนยัน'") — these rows
   * are hidden from the AI history anyway, but the wording stays safe if
   * that ever changes.
   */

  /** Status bullet of the delivery card (fixed: the customer scans this). */
  private static readonly DELIVERY_STATUS_LINE = "แก้ไขแล้ว รอคุณลูกค้าตรวจสอบ";
  /** The ask under the delivery card, right above the chips. */
  private static readonly DELIVERY_NEXT_LINE =
    "ลองเข้าใช้งานอีกครั้ง แล้วแตะ 'ใช้งานได้แล้ว' หรือ 'ยังมีปัญหาอยู่' ข้างล่างนี้ได้เลยค่ะ";
  /** The ask under the waiting-for-customer card. */
  private static readonly WAITING_NEXT_LINE = "รบกวนส่งข้อมูลเพิ่มเติมมาในแชทนี้ได้เลยนะคะ ทีมงานจะได้ดำเนินการต่อค่ะ";

  /** Customer said it works (or asked to close): confirm before closing. */
  private static readonly CLOSE_QUESTION_VARIANTS = [
    "ดีใจด้วยนะคะที่ใช้งานได้แล้ว 🎉 ต้องการปิดเคส {ticket}{about} เลยไหมคะ แตะ 'ยืนยันปิดเคส' ได้เลยค่ะ",
    "ขอบคุณที่แจ้งนะคะ แอดมินขอยืนยันอีกครั้งค่ะ ปิดเคส {ticket}{about} ได้เลยใช่ไหมคะ",
    "รับทราบค่ะ ถ้าเรียบร้อยดีแล้ว แตะ 'ยืนยันปิดเคส' เพื่อปิดเคส {ticket}{about} ได้เลยนะคะ หรือถ้าอยากลองใช้งานเพิ่มก่อน แตะ 'ยังไม่ปิด' ได้ค่ะ",
    "ต้องการปิดเคส {ticket}{about} ใช่ไหมคะ ถ้าใช่แตะ 'ยืนยันปิดเคส' ข้างล่างนี้ได้เลยค่ะ",
  ] as const;

  /** Closing line of the closed card — the one line that still rotates (operator decision 2026-09-10). */
  private static readonly CLOSED_CLOSERS = [
    "ขอบคุณมากนะคะ ถ้าเจอปัญหาเดิมอีกทักมาบอกได้เลย แอดมินเปิดเคสให้ใหม่ได้ค่ะ",
    "ขอบคุณที่แจ้งเข้ามานะคะ หากพบปัญหาอีกทักแอดมินได้ตลอดเลยค่ะ",
    "ขอบคุณที่ช่วยทดสอบให้นะคะ มีอะไรเพิ่มเติมแจ้งแอดมินได้เสมอค่ะ",
    "ยินดีที่ได้ช่วยนะคะ ถ้าติดขัดตรงไหนอีกทักมาได้เลยค่ะ",
  ] as const;

  /** Same problem confirmed: the case goes back to engineering, nothing is asked. */
  private static readonly REOPENED_VARIANTS = [
    "ขออภัยด้วยนะคะ แอดมินส่งเคส {ticket} กลับให้ทีมงานดูซ้ำแล้วค่ะ มีความคืบหน้าจะรีบแจ้งนะคะ",
    "รับทราบค่ะ ส่งเคส {ticket} กลับให้ทีมงานตรวจสอบอีกครั้งแล้วนะคะ ขออภัยที่ยังไม่เรียบร้อยค่ะ เดี๋ยวแอดมินตามให้ค่ะ",
    "ขออภัยที่ยังติดอยู่นะคะ เคส {ticket} แอดมินเปิดกลับให้ทีมงานดูต่อแล้วค่ะ มีอัปเดตเมื่อไหร่จะรีบมาบอกนะคะ",
    "แอดมินแจ้งทีมงานให้กลับมาดูเคส {ticket} อีกรอบแล้วค่ะ ขออภัยในความไม่สะดวกนะคะ คืบหน้ายังไงจะรีบแจ้งค่ะ",
  ] as const;

  /** Reserved (the re-open line no longer asks for symptoms — operator decision 2026-09-08). */
  private static readonly REOPEN_ASK_VARIANTS = [] as const;

  /** After "ยังมีปัญหาอยู่": same problem or a new one? Two chips decide. */
  private static readonly REOPEN_WHICH_KIND_VARIANTS = [
    "ขออภัยด้วยนะคะ รบกวนแจ้งว่าเป็นปัญหาเดิมของเคส {ticket} หรือเป็นปัญหาใหม่ ที่ปุ่มข้างล่างนี้ได้เลยค่ะ",
    "ขออภัยที่ยังไม่เรียบร้อยนะคะ ขอเช็คนิดนึงค่ะ เป็นอาการเดิมของเคส {ticket} หรือเป็นปัญหาใหม่คะ แตะเลือกข้างล่างนี้ได้เลย",
    "รับทราบค่ะ ขออภัยด้วยนะคะ เพื่อส่งต่อให้ถูกทีม รบกวนบอกหน่อยค่ะว่าเป็นปัญหาเดิมของเคส {ticket} หรือปัญหาใหม่ แตะปุ่มข้างล่างนี้ได้เลยค่ะ",
  ] as const;

  private static readonly REOPEN_FEEDBACK_SAVED_VARIANTS = [
    "แนบรายละเอียดให้ทีมงานในเคส {ticket} แล้วนะคะ ขอบคุณค่ะ มีอะไรเพิ่มส่งมาได้อีกเลย",
    "รับไว้แล้วค่ะ ส่งต่อให้ทีมงานในเคส {ticket} เรียบร้อยนะคะ",
  ] as const;

  /** New problem: the delivered case is closed as done, and intake starts over. */
  private static readonly REOPEN_NEW_ISSUE_PROMPT_VARIANTS = [
    "รับทราบค่ะ แอดมินปิดเคส {ticket} ให้เรียบร้อยแล้วนะคะ ส่วนปัญหาใหม่ รบกวนเล่าอาการที่เจอมาได้เลยค่ะ ส่งรูปหน้าจอมาด้วยก็ได้นะคะ",
    "โอเคค่ะ เคส {ticket} แอดมินปิดให้แล้วนะคะ ปัญหาใหม่เล่ามาได้เลยค่ะ เจอตรงไหน ขึ้นข้อความอะไร แอดมินจะเปิดเคสให้ใหม่ค่ะ",
    "เรียบร้อยค่ะ ปิดเคส {ticket} ให้แล้วนะคะ แล้วปัญหาใหม่เป็นแบบไหนคะ พิมพ์อาการหรือส่งรูปมาได้เลย เดี๋ยวแอดมินดูให้ค่ะ",
  ] as const;

  /**
   * 30 minutes before the resolution target of a case that is still being
   * worked on: apologise and ask for patience, once per target. Never a
   * promise about when it will be done.
   */
  private static readonly DUE_EXTENSION_VARIANTS = [
    "ขออภัยด้วยนะคะ เคส {ticket} ทีมงานยังแก้ไขไม่เสร็จตามเวลาที่แจ้งไว้ค่ะ ขอเวลาเพิ่มอีกสักหน่อยนะคะ แอดมินกำลังเร่งให้อยู่ค่ะ",
    "แอดมินขออภัยนะคะ เคส {ticket} ใกล้ถึงเวลาที่แจ้งไว้แล้วแต่ทีมงานยังต้องใช้เวลาเพิ่มอีกนิดค่ะ กำลังเร่งดำเนินการให้ มีอะไรคืบหน้าจะรีบแจ้งนะคะ",
    "ต้องขออภัยจริง ๆ ค่ะ เคส {ticket} อาจใช้เวลานานกว่าที่แจ้งไว้นะคะ ทีมงานยังเร่งแก้อยู่ค่ะ ขอเวลาเพิ่มอีกสักครู่นะคะ",
    "เคส {ticket} ขออภัยนะคะที่ยังไม่เรียบร้อยตามกำหนด ทีมงานยังดำเนินการต่อเนื่องอยู่ค่ะ ขอเวลาอีกสักหน่อย เสร็จเมื่อไหร่แอดมินแจ้งทันทีค่ะ",
  ] as const;

  /** Engineering set Re-Open in Plane on a case the customer already confirmed. */
  private static readonly REOPENED_BY_TEAM_VARIANTS = [
    "ทีมงานขอเปิดเคส {ticket}{about} เพื่อตรวจสอบเพิ่มเติมนะคะ มีความคืบหน้าจะรีบแจ้งค่ะ",
    "แจ้งให้ทราบค่ะ เคส {ticket}{about} ทีมงานขอเปิดกลับมาดูอีกครั้งนะคะ เรียบร้อยเมื่อไหร่แอดมินจะแจ้งค่ะ",
    "เคส {ticket}{about} ทีมงานขอตรวจสอบเพิ่มเติมอีกหน่อยนะคะ ระหว่างนี้ถ้ามีข้อมูลเพิ่มส่งมาได้เลยค่ะ",
  ] as const;

  private static readonly REOPEN_TOO_OLD_VARIANTS = [
    "เคส {ticket} ปิดไปเกิน {days} วันแล้วค่ะ แอดมินขอเปิดเป็นเคสใหม่ให้นะคะ เล่าอาการที่เจอตอนนี้มาได้เลยค่ะ",
    "เคส {ticket} ปิดไปนานเกิน {days} วันแล้วนะคะ เพื่อให้ทีมงานติดตามได้ถูกต้อง แอดมินจะเปิดเคสใหม่ให้ค่ะ บอกอาการที่เจอมาได้เลย",
  ] as const;

  private static readonly REOPEN_QUESTION_VARIANTS = [
    "ต้องการเปิดเคส {ticket}{about} อีกครั้งใช่ไหมคะ แตะ 'เปิดเคสอีกครั้ง' ได้เลยค่ะ",
    "ขอยืนยันก่อนนะคะ จะเปิดเคส {ticket}{about} กลับมาให้ทีมงานดูอีกครั้งใช่ไหมคะ แตะ 'เปิดเคสอีกครั้ง' ได้เลยค่ะ",
  ] as const;

  /** "ยังไม่ปิด" — leave the case waiting, without nagging. */
  private static readonly CLOSE_DECLINED_VARIANTS = [
    "โอเคค่ะ ยังไม่ปิดเคส {ticket} นะคะ ลองใช้งานให้แน่ใจก่อนได้เลย พร้อมเมื่อไหร่ค่อยแจ้งแอดมินค่ะ",
    "รับทราบค่ะ เคส {ticket} ยังเปิดไว้ให้นะคะ ถ้าเรียบร้อยแล้วค่อยบอกแอดมินได้เลยค่ะ",
  ] as const;

  /** "ปิดเคส" with nothing open — answered at the edge, never sent to the AI. */
  private static readonly NO_OPEN_CASE_VARIANTS = [
    "ตอนนี้ไม่มีเคสที่เปิดอยู่ให้ปิดเลยค่ะ ทุกเรื่องที่แจ้งไว้เรียบร้อยหมดแล้วนะคะ ถ้ามีปัญหาใหม่แจ้งเข้ามาได้เลยค่ะ",
    "แอดมินเช็คแล้วไม่พบเคสที่ยังเปิดอยู่เลยค่ะ เลยยังไม่มีอะไรให้ปิดนะคะ มีเรื่องใหม่แจ้งมาได้เลยค่ะ",
    "ตอนนี้ไม่มีเคสค้างอยู่เลยค่ะ ทุกเคสปิดเรียบร้อยแล้วนะคะ ถ้าเจอปัญหาอีกทักมาได้เสมอค่ะ",
    "ไม่มีเคสที่เปิดอยู่ให้ปิดแล้วค่ะ เคสก่อนหน้าปิดไปเรียบร้อยหมดแล้วนะคะ ถ้าต้องการแจ้งเรื่องใหม่บอกแอดมินได้เลยค่ะ",
  ] as const;

  /** Several cases are open: list them and let the chips pick. */
  private static readonly WHICH_CASE_VARIANTS = [
    "ตอนนี้มีเคสเปิดอยู่หลายเคสค่ะ ต้องการปิดเคสไหนคะ แตะเลือกข้างล่างนี้ได้เลยค่ะ",
    "มีเคสที่ยังเปิดอยู่มากกว่าหนึ่งเคสนะคะ อยากปิดเคสไหน แตะเลือกได้เลยค่ะ",
  ] as const;

  /** Reminder after the customer stayed silent on the delivery message. */
  private static readonly NUDGE_VARIANTS = [
    "แอดมินขอติดตามเคส {ticket}{about} หน่อยนะคะ ทีมงานแก้ไขให้แล้ว รบกวนลองใช้งานดูค่ะ แล้วแตะบอกผลข้างล่างนี้ได้เลยนะคะ{deadline}",
    "ทักมาเตือนเคส {ticket}{about} ค่ะ ทีมงานแก้ไขเสร็จแล้วนะคะ ใช้งานได้แล้วหรือยังคะ แตะบอกแอดมินได้เลยค่ะ{deadline}",
    "เคส {ticket}{about} ที่ทีมงานแก้ไขไปแล้ว ไม่ทราบว่าลองใช้งานแล้วเป็นอย่างไรบ้างคะ แตะบอกผลข้างล่างนี้ได้เลยค่ะ{deadline}",
  ] as const;

  private static readonly AUTO_CLOSED_VARIANTS = [
    "แอดมินปิดเคส {ticket} ให้อัตโนมัติแล้วนะคะ เนื่องจากไม่ได้รับการยืนยันกลับ ถ้ายังพบปัญหาอยู่ทักมาบอกได้เลยค่ะ แอดมินเปิดเคสให้ใหม่ได้ทันที",
    "เคส {ticket} ถูกปิดอัตโนมัติแล้วค่ะ เพราะไม่มีการตอบกลับหลังทีมงานแก้ไขเสร็จนะคะ หากยังมีปัญหาแจ้งกลับมาได้เลยค่ะ",
  ] as const;

  // -------------------------------------------------------------------------
  // Post-ticket cancel (Flow 5, operator decision 2026-09-17). None of these
  // contain "ปิดเคส" (the close-question detector) nor the create-confirmation
  // markers ("ปุ่มด้านล่าง", "กดปุ่ม 'ยืนยัน'"), so the pending-question
  // detector in CustomerConfirmationHandler reads them unambiguously.
  // -------------------------------------------------------------------------

  /** "ยกเลิกเคส" received: confirm before anything changes. */
  private static readonly CANCEL_QUESTION_VARIANTS = [
    "ระบบตรวจพบคำขอยกเลิกเคส {ticket}{about}\nเพื่อความถูกต้อง ต้องการยืนยันการยกเลิกเคสนี้ใช่ไหมคะ",
    "ต้องการยกเลิกเคส {ticket}{about} ใช่ไหมคะ ถ้าใช่แตะ 'ยืนยันยกเลิกเคส' ข้างล่างนี้ได้เลยค่ะ ถ้ายังอยากให้ทีมงานดูต่อ แตะ 'ไม่ยกเลิก' นะคะ",
    "รับทราบค่ะ ขอเช็คอีกครั้งนะคะ จะยกเลิกเคส {ticket}{about} เลยใช่ไหมคะ แตะ 'ยืนยันยกเลิกเคส' ได้เลยค่ะ หรือแตะ 'ไม่ยกเลิก' ถ้าเปลี่ยนใจนะคะ",
    "โอเคค่ะ ก่อนยกเลิกเคส {ticket}{about} แอดมินขอให้ยืนยันอีกครั้งนะคะ แตะ 'ยืนยันยกเลิกเคส' ข้างล่างนี้ได้เลยค่ะ",
  ] as const;

  /**
   * [เปิดเคสใหม่จากเรื่องนี้] tapped under the closed-case protection
   * (2026-09-18): the new case will be linked to {ticket}; ask for the report.
   */
  private static readonly FOLLOW_UP_PROMPT_VARIANTS = [
    "ได้เลยค่ะ จะเปิดเคสใหม่ต่อจาก {ticket}{about} ให้นะคะ เล่าอาการที่พบตอนนี้มาได้เลยค่ะ ส่งรูปหน้าจอมาด้วยก็ได้นะคะ",
    "รับทราบค่ะ เปิดเคสใหม่อ้างอิงเคส {ticket} ให้นะคะ รบกวนพิมพ์อาการที่เจอตอนนี้มาได้เลยค่ะ มีรูปหน้าจอแนบมาด้วยยิ่งดีค่ะ",
    "โอเคค่ะ เดี๋ยวแอดมินเปิดเคสใหม่ต่อจาก {ticket} ให้ค่ะ ปัญหาที่เจอตอนนี้เป็นแบบไหนคะ พิมพ์อาการหรือส่งรูปมาได้เลยค่ะ",
  ] as const;

  /** A bare "เปิดเคสใหม่" / [แจ้งเรื่องใหม่] with no case to link: just ask for the report. */
  private static readonly NEW_CASE_PROMPT_VARIANTS = [
    "ได้เลยค่ะ แจ้งรายละเอียดปัญหาที่พบมาได้เลยนะคะ ถ้ามีภาพหน้าจอแนบมาด้วยจะช่วยให้เช็กไวขึ้นค่ะ",
    "รับทราบค่ะ เล่าอาการที่เจอมาได้เลยค่ะ เจอตรงไหน ขึ้นข้อความอะไร แอดมินจะเปิดเคสให้ใหม่ค่ะ",
    "โอเคค่ะ ปัญหาใหม่เป็นแบบไหนคะ พิมพ์อาการหรือส่งรูปหน้าจอมาได้เลย เดี๋ยวแอดมินเปิดเคสให้ค่ะ",
  ] as const;

  /** Closing line of the cancelled card (operator-approved set, 2026-09-18). */
  private static readonly CANCELLED_CLOSERS = [
    "หากต้องการแจ้งปัญหาใหม่ ทักมาได้เลยค่ะ",
    "ยกเลิกเคสนี้ให้เรียบร้อยแล้วนะคะ มีเรื่องอื่นให้ช่วย แจ้งได้เสมอค่ะ",
    "รับทราบและยกเลิกเคสให้แล้วค่ะ ถ้าเจอปัญหาอีก ทักแอดมินได้ตลอดนะคะ",
    "เรียบร้อยค่ะ ขอบคุณที่แจ้งให้ทราบนะคะ มีอะไรเพิ่มเติมพิมพ์มาได้เลยค่ะ",
  ] as const;

  /** "ไม่ยกเลิก" — the case keeps going. */
  private static readonly CANCEL_DECLINED_VARIANTS = [
    "โอเคค่ะ ไม่ยกเลิกเคส {ticket} นะคะ ทีมงานดำเนินการต่อตามปกติค่ะ",
    "รับทราบค่ะ เคส {ticket} ยังเปิดอยู่เหมือนเดิมนะคะ มีอะไรเพิ่มเติมแจ้งได้เลยค่ะ",
  ] as const;

  /** Several cases are open: list them and let the chips pick which to cancel. */
  private static readonly CANCEL_WHICH_CASE_VARIANTS = [
    "ตอนนี้มีเคสเปิดอยู่หลายเคสค่ะ ต้องการยกเลิกเคสไหนคะ แตะเลือกจากรายการนี้ได้เลยค่ะ",
    "มีเคสที่ยังเปิดอยู่มากกว่าหนึ่งเคสนะคะ อยากยกเลิกเคสไหน แตะเลือกจากรายการนี้ได้เลยค่ะ",
  ] as const;

  private static readonly CANCEL_NO_OPEN_CASE_VARIANTS = [
    "ตอนนี้ไม่มีเคสที่เปิดอยู่ให้ยกเลิกเลยค่ะ ถ้ามีเรื่องใหม่แจ้งเข้ามาได้เลยนะคะ",
    "แอดมินเช็คแล้วไม่พบเคสที่ยังเปิดอยู่ค่ะ เลยไม่มีอะไรต้องยกเลิกนะคะ มีเรื่องใหม่ทักมาได้เลยค่ะ",
  ] as const;

  private static readonly CANCEL_CASE_NOT_OPEN_VARIANTS = [
    "เคส {ticket} ไม่ได้เปิดอยู่แล้วค่ะ เลยไม่มีอะไรต้องยกเลิกนะคะ ถ้าเจอปัญหาอีกแจ้งแอดมินได้เลยค่ะ",
    "เคส {ticket} ปิดหรือยกเลิกไปเรียบร้อยแล้วค่ะ ไม่ต้องยกเลิกเพิ่มนะคะ มีเรื่องใหม่ทักมาได้เลยค่ะ",
  ] as const;

  private static pickVariant(variants: readonly string[], seed?: string | null): string {
    if (!seed) return variants[0];
    const digest = createHash("sha256").update(seed).digest();
    return variants[digest[0] % variants.length];
  }

  /**
   * Rotating pick for periodic messages. A hash pick can land on the same
   * variant twice in a row (seen: hourly slots 3 and 4 identical); when the
   * seed ends in a slot number the variant simply cycles with it, so
   * consecutive reports are guaranteed to differ. Non-numeric seeds (manual
   * test keys) fall back to the hash pick.
   */
  private static pickRotating(variants: readonly string[], seed: string | null | undefined, offset = 0): string {
    const m = /(\d+)\s*$/.exec(String(seed || ""));
    if (!m) return CustomerNotificationService.pickVariant(variants, seed);
    return variants[(Number(m[1]) + offset) % variants.length];
  }

  /**
   * Opener, blank line, "• label: value" bullets, blank line, closer. LINE
   * text messages render "\n" and "•" as-is (no markup of any kind, so bold
   * is not an option there); the WebChat views render with pre-wrap. Blank
   * or missing values are dropped rather than shown as an empty bullet.
   */
  private static layout(opener: string, bullets: Array<[label: string, value: string | null | undefined]>, closer: string): string {
    const lines = bullets
      .map(([label, value]) => [label, String(value || "").trim()] as const)
      .filter(([, value]) => value.length > 0)
      .map(([label, value]) => `• ${label}: ${value}`);
    return [opener, lines.join("\n"), closer].filter((part) => part.length > 0).join("\n\n");
  }

  /** " (subject)" for the auto-attach lines; empty when there is no subject. Capped so the line stays one bubble. */
  private static imageCaseAbout(subject?: string | null): string {
    const raw = String(subject || "").replace(/\s+/g, " ").trim();
    if (!raw) return "";
    return ` (${raw.length > 80 ? `${raw.slice(0, 80)}…` : raw})`;
  }

  /** The "เรื่อง" bullet value: the full subject (operator decision 2026-09-10: never cut it short); a hard cap far beyond any real subject keeps LINE's 5000-char limit safe. */
  private static subjectLine(subject?: string | null): string {
    const raw = String(subject || "").replace(/\s+/g, " ").trim();
    return raw.length > 1000 ? `${raw.slice(0, 1000)}…` : raw;
  }

  /**
   * Pure rendering of notification text for previewing, formatting, or testing
   * without hitting database or sending real messages.
   */
  static renderContent(options: {
    notificationType: CustomerNotificationType;
    ticketNumber?: string | null;
    subject?: string | null;
    detail?: string | null;
    seed?: string | null;
    facts?: CaseFacts | null;
  }): string {
    return customerNotificationService.body(
      options.notificationType,
      options.ticketNumber,
      options.seed,
      options.subject,
      options.detail,
      options.facts
    );
  }

  /** Wording is deliberately conservative — see rule 2 above. */
  private body(
    type: CustomerNotificationType,
    ticketNumber?: string | null,
    seed?: string | null,
    subject?: string | null,
    detail?: string | null,
    facts?: CaseFacts | null
  ): string {
    const card = { ...(facts || {}), subject: subject ?? facts?.subject ?? null };
    switch (type) {
      case "progress_update":
        // Hourly SLA report and the console's "force send": the card with the
        // current status and the target time. `detail` from older callers is
        // ignored — the card is built from facts only.
        return CustomerNotificationService.caseBlock(ticketNumber, card, customerStatusLabel(card.status), CustomerNotificationService.dueLine(card));
      case "waiting_customer":
        return CustomerNotificationService.caseBlock(
          ticketNumber,
          card,
          customerStatusLabel("WAITING_CUSTOMER"),
          `${CustomerNotificationService.dueLine(card)}\n${CustomerNotificationService.WAITING_NEXT_LINE}`
        );
      case "acknowledgement":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.ACK_VARIANTS, seed);
      case "acknowledgement_action":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.ACK_ACTION_VARIANTS, seed);
      case "acknowledgement_edit":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.ACK_EDIT_VARIANTS, seed);
      case "acknowledgement_choice":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.ACK_CHOICE_VARIANTS, seed);
      case "resolution_which_case": {
        const list = String(detail || "").trim();
        const head = CustomerNotificationService.pickVariant(CustomerNotificationService.RESOLUTION_WHICH_CASE_VARIANTS, seed);
        return list ? `${head}\n\n${list}` : head;
      }
      case "action_failed":
        return this.fill(CustomerNotificationService.ACTION_FAILED_VARIANTS, seed, ticketNumber, null);
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
      // Screenshot right after a case was opened: attached to it without asking.
      // The case is named with its subject so a wrong guess is visible at once,
      // and the tail invites a one-line correction (not a question).
      case "image_auto_attached": {
        const n = ticketNumber || "ที่เพิ่งเปิด";
        const about = CustomerNotificationService.imageCaseAbout(subject);
        const line = CustomerNotificationService.pickVariant(
          [
            `ได้รับรูปแล้วนะคะ แนบเข้าเคส ${n}${about} ให้เรียบร้อยแล้วค่ะ`,
            `รับรูปแล้วค่ะ เก็บเข้าเคส ${n}${about} ให้แล้วนะคะ`,
            `แนบรูปเข้าเคส ${n}${about} เรียบร้อยแล้วค่ะ`,
          ],
          seed
        );
        return `${line} ถ้าไม่ใช่รูปของเคสนี้ พิมพ์บอกแอดมินได้เลยนะคะ`;
      }
      case "image_auto_attach_pending": {
        const n = ticketNumber || "ที่เพิ่งเปิด";
        return `ได้รับรูปแล้วนะคะ กำลังแนบเข้าเคส ${n}${CustomerNotificationService.imageCaseAbout(subject)} ให้ค่ะ ถ้าไม่ใช่รูปของเคสนี้ พิมพ์บอกแอดมินได้เลยนะคะ`;
      }
      case "ticket_created":
        return ticketNumber
          ? `สร้างเคส #${ticketNumber} ให้แล้วนะคะ ทีมงานกำลังตรวจสอบให้อยู่ค่ะ`
          : "สร้างเคสให้แล้วนะคะ ทีมงานกำลังตรวจสอบให้อยู่ค่ะ";
      case "resolution_confirmation": {
        // "เสร็จสิ้น" = when engineering set Delivery to Customer (resolved_at,
        // written by the same transition that triggers this message).
        const finished = thaiDateStamp(card.resolvedAt || new Date());
        return CustomerNotificationService.caseBlock(
          ticketNumber,
          card,
          CustomerNotificationService.DELIVERY_STATUS_LINE,
          `${finished ? `เสร็จสิ้น ${finished}\n` : ""}${CustomerNotificationService.DELIVERY_NEXT_LINE}`
        );
      }
      case "close_confirmation_request":
        return this.fill(CustomerNotificationService.CLOSE_QUESTION_VARIANTS, seed, ticketNumber, subject);
      case "closed":
        return CustomerNotificationService.caseBlock(
          ticketNumber,
          card,
          customerStatusLabel("CLOSED"),
          CustomerNotificationService.pickVariant(CustomerNotificationService.CLOSED_CLOSERS, seed)
        );
      case "reopened":
        return this.fill(CustomerNotificationService.REOPENED_VARIANTS, seed, ticketNumber, null);
      case "due_extension_notice":
        return this.fill(CustomerNotificationService.DUE_EXTENSION_VARIANTS, seed, ticketNumber, null);
      case "reopen_which_kind":
        return this.fill(CustomerNotificationService.REOPEN_WHICH_KIND_VARIANTS, seed, ticketNumber, subject);
      case "reopen_feedback_saved":
        return this.fill(CustomerNotificationService.REOPEN_FEEDBACK_SAVED_VARIANTS, seed, ticketNumber, null);
      case "reopen_new_issue_prompt":
        return this.fill(CustomerNotificationService.REOPEN_NEW_ISSUE_PROMPT_VARIANTS, seed, ticketNumber, null);
      case "reopened_by_team":
        return this.fill(CustomerNotificationService.REOPENED_BY_TEAM_VARIANTS, seed, ticketNumber, subject);
      case "reopen_too_old":
        return this.fill(CustomerNotificationService.REOPEN_TOO_OLD_VARIANTS, seed, ticketNumber, null).replace("{days}", String(detail || "7"));
      case "reopen_confirmation_request":
        return this.fill(CustomerNotificationService.REOPEN_QUESTION_VARIANTS, seed, ticketNumber, subject);
      case "close_declined":
        return this.fill(CustomerNotificationService.CLOSE_DECLINED_VARIANTS, seed, ticketNumber, null);
      case "close_no_open_case":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.NO_OPEN_CASE_VARIANTS, seed);
      case "close_which_case": {
        // `detail` carries the pre-formatted case list (one line per case).
        const list = String(detail || "").trim();
        const head = CustomerNotificationService.pickVariant(CustomerNotificationService.WHICH_CASE_VARIANTS, seed);
        return list ? `${head}\n\n${list}` : head;
      }
      case "resolution_nudge": {
        // `detail` is the plain-Thai auto-close notice, when auto-close is on.
        const deadline = String(detail || "").trim();
        return this.fill(CustomerNotificationService.NUDGE_VARIANTS, seed, ticketNumber, subject)
          .replace("{deadline}", deadline ? ` ${deadline}` : "");
      }
      case "auto_closed":
        return this.fill(CustomerNotificationService.AUTO_CLOSED_VARIANTS, seed, ticketNumber, null);
      case "cancel_confirmation_request":
        return this.fill(CustomerNotificationService.CANCEL_QUESTION_VARIANTS, seed, ticketNumber, subject);
      case "cancelled":
        return CustomerNotificationService.caseBlock(
          ticketNumber,
          card,
          customerStatusLabel("CANCELLED"),
          CustomerNotificationService.pickVariant(CustomerNotificationService.CANCELLED_CLOSERS, seed)
        );
      case "cancel_declined":
        return this.fill(CustomerNotificationService.CANCEL_DECLINED_VARIANTS, seed, ticketNumber, null);
      case "cancel_which_case": {
        const list = String(detail || "").trim();
        const head = CustomerNotificationService.pickVariant(CustomerNotificationService.CANCEL_WHICH_CASE_VARIANTS, seed);
        return list ? `${head}\n\n${list}` : head;
      }
      case "cancel_no_open_case":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.CANCEL_NO_OPEN_CASE_VARIANTS, seed);
      case "cancel_case_not_open":
        return this.fill(CustomerNotificationService.CANCEL_CASE_NOT_OPEN_VARIANTS, seed, ticketNumber, null);
      case "case_context":
        // The case resolver composed the whole message (which case? closed
        // case?); `detail` is that text and the caller supplies the chips.
        return String(detail || "").trim() || "คุณลูกค้าหมายถึงเคสไหนคะ";
      case "follow_up_prompt":
        return this.fill(CustomerNotificationService.FOLLOW_UP_PROMPT_VARIANTS, seed, ticketNumber, subject);
      case "new_case_prompt":
      case "report_prompt":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.NEW_CASE_PROMPT_VARIANTS, seed);
      case "ai_timeout_fallback":
        return CustomerNotificationService.pickVariant(CustomerNotificationService.AI_TIMEOUT_FALLBACK_VARIANTS, seed);
      case "sticker_reply":
        // Usually a sticker alone; `detail` is the one follow-up line some moods get.
        return String(detail || "").trim();
      case "sticker_reminder":
        return "แตะปุ่มด้านล่างเพื่อตอบได้เลยนะคะ";
    }
  }

  /** Types rendered as the case card, which needs the ticket row. */
  private static readonly CARD_TYPES: ReadonlySet<CustomerNotificationType> = new Set<CustomerNotificationType>([
    "progress_update",
    "resolution_confirmation",
    "waiting_customer",
    "closed",
    "cancelled",
  ]);

  /**
   * Facts for the card: what the caller passed, completed from `tickets` by
   * id. A read failure degrades to whatever the caller supplied — the message
   * still goes out, possibly without the "แจ้งเมื่อ" line.
   */
  private async factsFor(req: SendRequest): Promise<CaseFacts | null> {
    if (!CustomerNotificationService.CARD_TYPES.has(req.notificationType)) return req.facts ?? null;
    if (!req.ticketId) return req.facts ?? null;
    try {
      const { rows } = await pool.query<{ status: string | null; subject: string | null; created_at: Date | null; due_date: Date | null; resolved_at: Date | null }>(
        `SELECT status, subject, created_at, due_date, resolved_at FROM tickets WHERE id = $1 LIMIT 1`,
        [req.ticketId]
      );
      const row = rows[0];
      if (!row) return req.facts ?? null;
      return {
        status: req.facts?.status ?? row.status,
        subject: req.facts?.subject ?? row.subject,
        createdAt: req.facts?.createdAt ?? row.created_at,
        dueAt: req.facts?.dueAt ?? row.due_date,
        resolvedAt: req.facts?.resolvedAt ?? row.resolved_at,
      };
    } catch (err: any) {
      logger.warn({ ticketId: req.ticketId, error: err?.message }, "Could not load case facts for the notification card");
      return req.facts ?? null;
    }
  }

  /** Substitutes {ticket} and {about} in a picked variant. */
  private fill(variants: readonly string[], seed: string | null | undefined, ticketNumber?: string | null, subject?: string | null): string {
    const raw = String(subject || "").trim();
    const shown = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
    return CustomerNotificationService.pickVariant(variants, seed)
      .replace("{ticket}", ticketNumber ? ticketNumber : "ที่แจ้งไว้")
      .replace("{about}", shown ? ` เรื่อง "${shown}"` : "");
  }

  /**
   * Chips attached when the caller does not choose its own. Each chip's text
   * carries the case number so the reply is unambiguous with several cases
   * open, and so nothing here is a bare "ยืนยัน" (the AI gate's create-
   * confirmation word).
   */
  static defaultQuickReplies(type: CustomerNotificationType, ticketNumber?: string | null): NotificationQuickReply[] {
    const n = ticketNumber ? ` ${ticketNumber}` : "";
    switch (type) {
      case "resolution_confirmation":
      case "resolution_nudge":
        return [
          { label: "ใช้งานได้แล้ว", text: `ใช้งานได้แล้ว${n}` },
          { label: "ยังมีปัญหาอยู่", text: `ยังมีปัญหาอยู่${n}` },
        ];
      case "close_confirmation_request":
        // No "ยังมีปัญหาอยู่" here: the customer has just said it works, so
        // asking again reads as a repeat (operator decision 2026-09-08).
        return [
          { label: "ยืนยันปิดเคส", text: `ยืนยันปิดเคส${n}` },
          { label: "ยังไม่ปิด", text: "ยังไม่ปิด" },
        ];
      case "reopen_which_kind":
        return [
          { label: "ปัญหาเดิม", text: `ปัญหาเดิม${n}` },
          { label: "ปัญหาใหม่", text: `ปัญหาใหม่${n}` },
        ];
      case "reopen_confirmation_request":
        return [
          // Label ≤ 20 chars (LINE limit); the sent text keeps the full confirmation phrase.
          { label: "เปิดเคสอีกครั้ง", text: `ยืนยันเปิดเคสอีกครั้ง${n}` },
          { label: "ยกเลิก", text: "ยกเลิก" },
        ];
      case "cancel_confirmation_request":
        // The confirmation chip carries the case number; "ไม่ยกเลิก" is only
        // read as a decline while this question is pending.
        return [
          { label: "ยืนยันยกเลิกเคส", text: `ยืนยันยกเลิกเคส${n}` },
          { label: "ไม่ยกเลิก", text: "ไม่ยกเลิก" },
        ];
      case "ai_timeout_fallback":
        return [
          { label: "ตรวจสอบสถานะ", text: "ตรวจสอบสถานะ" },
          { label: "ติดต่อเจ้าหน้าที่", text: "ขอคุยกับเจ้าหน้าที่" },
        ];
      default:
        return [];
    }
  }

  /**
   * Chips of the newest still-open question in this conversation: the
   * delivery message (ticket RESOLVED) or the close question (ticket
   * CUSTOMER_CONFIRMED), asked within the last 24 hours. Empty when the
   * customer owes nothing.
   */
  private async pendingQuestionChips(conversationId: number, ticketId: number): Promise<NotificationQuickReply[]> {
    try {
      const { rows } = await pool.query<{ notification_type: CustomerNotificationType; ticket_number: string | null; status: string }>(
        `SELECT n.notification_type, t.ticket_number, UPPER(t.status) AS status
           FROM customer_notifications n
           JOIN tickets t ON t.id = n.ticket_id
          WHERE n.conversation_id = $1
            AND n.ticket_id = $2
            AND n.notification_type IN ('resolution_confirmation', 'resolution_nudge', 'close_confirmation_request', 'cancel_confirmation_request')
            AND n.created_at >= NOW() - INTERVAL '24 hours'
            AND t.deleted_at IS NULL
            AND UPPER(t.status) NOT IN ('CLOSED', 'CANCELLED')
          ORDER BY n.id DESC LIMIT 1`,
        [conversationId, ticketId]
      );
      const row = rows[0];
      if (!row) return [];
      // The cancel question stands on any still-open case; the delivery /
      // close questions only while the case is actually waiting on the customer.
      if (row.notification_type === "cancel_confirmation_request") {
        return CustomerNotificationService.defaultQuickReplies("cancel_confirmation_request", row.ticket_number);
      }
      if (row.status !== "RESOLVED" && row.status !== "CUSTOMER_CONFIRMED") return [];
      const type: CustomerNotificationType = row.status === "CUSTOMER_CONFIRMED" ? "close_confirmation_request" : "resolution_confirmation";
      return CustomerNotificationService.defaultQuickReplies(type, row.ticket_number);
    } catch {
      return [];
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
       -- A row that FAILED to deliver may be claimed again (2026-09-08: a LINE
       -- push timed out and the delivery question was silently lost for good).
       -- Sent / pending rows still block, so at-most-once delivery holds.
       ON CONFLICT (notification_type, idempotency_key) DO UPDATE
         SET status = 'pending', error_message = NULL, updated_at = NOW()
         WHERE customer_notifications.status = 'failed'
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
  private async pushLine(
    recipientRef: string,
    text: string,
    quickReplies: NotificationQuickReply[] = [],
    sticker: LineSticker | null = null
  ): Promise<void> {
    const token = (config.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
    if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");

    const message: Record<string, unknown> = { type: "text", text };
    // The sticker goes first, so the chips stay on the text bubble (LINE shows
    // quick replies on the last message only). A sticker-only reply has no text.
    const messages: Record<string, unknown>[] = [
      ...(sticker ? [stickerMessage(sticker)] : []),
      ...(String(text || "").trim() ? [message] : []),
    ];
    if (messages.length === 0) throw new Error("Nothing to send: empty text and no sticker");
    if (quickReplies.length > 0) {
      // LINE allows at most 13 items; labels are capped at 20 characters.
      message.quickReply = {
        items: quickReplies.slice(0, 13).map((item) => ({
          type: "action",
          action: { type: "message", label: item.label.slice(0, 20), text: item.text },
        })),
      };
    }

    // Two attempts with a 15 s budget each: a 10 s single shot lost a delivery
    // question to a slow LINE response (2026-09-08). Only transport-level
    // failures are retried; a 4xx is a bad message and is reported as such.
    let lastErr: any;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await axios.post(
          "https://api.line.me/v2/bot/message/push",
          { to: recipientRef, messages },
          { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, timeout: 15000 }
        );
        return;
      } catch (err: any) {
        lastErr = err;
        const status = Number(err?.response?.status || 0);
        // LINE answered 400 "Failed to send messages" twice today for a
        // payload its validate endpoint accepts and a later identical push
        // delivered — so a 400 gets one retry too; only a 401/403 (token)
        // is final.
        const transient = !status || status >= 500 || status === 429 || status === 400;
        if (!transient || attempt === 2) throw err;
        logger.warn({ attempt, error: err.message }, "LINE push failed transiently; retrying once");
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    throw lastErr;
  }

  /**
   * Re-sends notifications whose delivery failed (transport errors only —
   * a 4xx means the message itself was rejected and is left for a human).
   * Called by the SLA cadence engine on every pass; the stored body is
   * pushed as-is with the type's default chips, so the customer sees exactly
   * what was intended. Returns how many were sent.
   */
  async retryFailed(opts: { maxAgeMinutes?: number; limit?: number } = {}): Promise<number> {
    const maxAge = opts.maxAgeMinutes ?? 180;
    const limit = opts.limit ?? 10;
    const { rows } = await pool.query<{
      id: number; conversation_id: number; ticket_id: number | null; notification_type: CustomerNotificationType;
      recipient_ref: string; channel: string; body: string; error_message: string | null; ticket_number: string | null;
    }>(
      `SELECT n.id, n.conversation_id, n.ticket_id, n.notification_type, n.recipient_ref, n.channel, n.body, n.error_message,
              t.ticket_number
         FROM customer_notifications n
         LEFT JOIN tickets t ON t.id = n.ticket_id
        WHERE n.status = 'failed'
          AND n.created_at >= NOW() - ($1::int * INTERVAL '1 minute')
          -- Token / permission errors are final; everything else (timeouts,
          -- 5xx, LINE's transient 400 "Failed to send messages") is retried
          -- up to three times, counted in the error text.
          AND COALESCE(n.error_message, '') NOT ILIKE '%status code 401%'
          AND COALESCE(n.error_message, '') NOT ILIKE '%status code 403%'
          AND COALESCE(n.error_message, '') NOT ILIKE '[retry 3]%'
          AND n.notification_type NOT IN ('acknowledgement', 'acknowledgement_action', 'acknowledgement_edit', 'acknowledgement_choice', 'greeting', 'thanks', 'image_auto_attached', 'image_auto_attach_pending', 'sticker_reply', 'sticker_reminder')
        ORDER BY n.id ASC
        LIMIT $2`,
      [maxAge, limit]
    );
    let sent = 0;
    for (const row of rows) {
      if (row.channel !== "line" || !row.recipient_ref) continue;
      try {
        await this.pushLine(row.recipient_ref, row.body, CustomerNotificationService.defaultQuickReplies(row.notification_type, row.ticket_number));
        await this.markSent(row.id);
        await this.appendToConversation(row.conversation_id, row.body);
        sent += 1;
        logger.info({ notificationId: row.id, type: row.notification_type, ticketNumber: row.ticket_number }, "Failed customer notification re-sent");
      } catch (err: any) {
        const prev = /^\[retry (\d+)\]/.exec(String(row.error_message || ""));
        const attempt = prev ? Number(prev[1]) + 1 : 1;
        const detail = err?.response?.data ? ` ${JSON.stringify(err.response.data).slice(0, 200)}` : "";
        await this.markFailed(row.id, `[retry ${attempt}] ${err.message}${detail}`);
        logger.warn({ notificationId: row.id, attempt, error: err.message }, "Retry of failed customer notification failed again");
      }
    }
    return sent;
  }

  private redisPub: Redis | null = null;

  private getRedisPub(): Redis {
    if (!this.redisPub) {
      this.redisPub = createRedisClient("customer-notification-pub", { maxRetriesPerRequest: null });
    }
    return this.redisPub;
  }

  /** Pushes a WebChat notification with normalized buttons across Redis and in-memory. */
  private async pushWebChat(
    conversationId: number,
    recipientRef: string,
    text: string,
    messageId: number | null,
    quickReplies: NotificationQuickReply[] = []
  ): Promise<void> {
    const actions = (quickReplies || []).map((qr) => ({
      label: qr.label,
      value: qr.text,
      style: qr.label.includes("ผ่าน") || qr.label.includes("ยืนยัน") ? ("primary" as const) : undefined,
    }));

    const outboundPayload = {
      conversationId: String(conversationId),
      recipientId: recipientRef,
      channel: "WebChat" as const,
      id: messageId ? String(messageId) : undefined,
      externalId: messageId ? String(messageId) : undefined,
      messageId: messageId ?? undefined,
      text,
      role: "ai" as const,
      sentAt: new Date().toISOString(),
      actions: actions.length > 0 ? actions : undefined,
    };

    // 1. Direct in-memory broadcast for immediate local socket delivery
    try {
      broadcastWebChatOutbound(outboundPayload);
    } catch (inMemErr: any) {
      logger.warn({ error: inMemErr.message, conversationId }, "WebChat in-memory notification broadcast failed");
    }

    // 2. Redis publish for horizontal scaling across instances
    try {
      const pub = this.getRedisPub();
      await pub.publish("webchat:outbound", JSON.stringify(outboundPayload));
    } catch (redisErr: any) {
      logger.warn({ error: redisErr.message, conversationId }, "WebChat Redis notification publish failed");
    }
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
    // The edit acknowledgement answers a chip tap, so it is never held back
    // by the burst window; it still counts as the burst's acknowledgement for
    // whatever the customer sends next.
    if (req.notificationType === "acknowledgement" || req.notificationType === "acknowledgement_action" || req.notificationType === "acknowledgement_choice") {
      const recent = await pool.query(
        `SELECT 1 FROM customer_notifications
          WHERE conversation_id = $1
            AND notification_type IN ('acknowledgement', 'acknowledgement_action', 'acknowledgement_edit', 'acknowledgement_choice')
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

    const facts = await this.factsFor(req);
    const body = this.body(req.notificationType, req.ticketNumber, req.idempotencyKey, req.subject ?? facts?.subject ?? null, req.detail, facts);

    // LINE sticker (2026-09-24): decided before the claim, because a
    // sticker-only reply that may not send a sticker has nothing to say.
    let sticker: LineSticker | null = null;
    if (recipient.channel === "line") {
      const wanted = req.sticker !== undefined ? req.sticker : NOTIFICATION_STICKERS[req.notificationType] ?? null;
      if (wanted && (await this.stickerAllowed(req.conversationId, THROTTLED_STICKER_TYPES.has(req.notificationType)))) sticker = wanted;
    }
    if (!body.trim() && !sticker) {
      return { sent: false, reason: "NOTHING_TO_SEND" };
    }

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

    let quickReplies =
      req.quickReplies === undefined || req.quickReplies === null
        ? CustomerNotificationService.defaultQuickReplies(req.notificationType, req.ticketNumber)
        : req.quickReplies;
    // Sticky chips. LINE shows quick replies on the newest bubble only, so an
    // acknowledgement or an SLA progress line pushed while the customer still
    // owes an answer would wipe the buttons. Re-attach the pending question's
    // chips to any message that carries none of its own.
    // Only on messages that are about that same case (SLA progress line,
    // reminder). Attaching them to the acknowledgement of a NEW report read as
    // "did the fix work?" on a problem that was just filed (seen live
    // 2026-09-08, Error 909 report).
    if (
      quickReplies.length === 0 &&
      (req.quickReplies === undefined || req.quickReplies === null) &&
      (req.notificationType === "progress_update" || req.notificationType === "resolution_nudge") &&
      req.ticketId
    ) {
      quickReplies = await this.pendingQuestionChips(req.conversationId, Number(req.ticketId));
    }

    let insertedMsgId: number | null = null;
    try {
      if (recipient.channel === "line") {
        await this.pushLine(recipient.recipientRef, body, quickReplies, sticker);
        if (sticker) await this.recordSticker(req.conversationId, sticker);
        if (body.trim()) insertedMsgId = await this.appendToConversation(req.conversationId, body);
      } else if (recipient.channel === "webchat") {
        insertedMsgId = await this.appendToConversation(req.conversationId, body);
        await this.pushWebChat(req.conversationId, recipient.recipientRef, body, insertedMsgId, quickReplies);
      } else {
        // Other channels deliver through their own gateway; the ledger row
        // and the conversation record are still written.
        logger.info({ channel: recipient.channel }, "Non-LINE/WebChat channel: notification recorded, delivery delegated");
        insertedMsgId = await this.appendToConversation(req.conversationId, body);
      }

      await this.markSent(claimId);

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
      // LINE explains a 4xx in the response body ("invalid property",
      // "The request body has N error(s)"); keep it, or a 400 is undiagnosable.
      const detail = err?.response?.data ? ` ${JSON.stringify(err.response.data).slice(0, 300)}` : "";
      const errorText = `${err.message}${detail}`;
      await this.markFailed(claimId, errorText);
      await traceRecorder.record({
        correlationId: req.correlationId || `notify-${claimId}`,
        component: "notification",
        eventType: `${req.notificationType}_failed`,
        status: "failed",
        conversationId: req.conversationId,
        ticketId: req.ticketId ?? null,
        errorMessage: errorText,
      });
      // Still record what we intended to say, so the thread is not silently
      // missing a turn the customer may or may not have received.
      if (!insertedMsgId && body.trim()) {
        await this.appendToConversation(req.conversationId, body);
      }
      logger.error(
        { conversationId: req.conversationId, type: req.notificationType, error: err.message },
        "Customer notification delivery failed"
      );
      return { sent: false, reason: "DELIVERY_FAILED", body };
    }
  }

  /**
   * Whether the bot may send a sticker in this conversation now: enabled, the
   * AI (not a staff member) owns the chat, and — for a `throttled` (repeatable)
   * trigger — no bot sticker in the last STICKER_MIN_INTERVAL_MINUTES.
   * Any doubt means no sticker.
   */
  async stickerAllowed(conversationId: number, throttled = false): Promise<boolean> {
    if (!config.LINE_STICKERS_ENABLED) return false;
    try {
      const { rows } = await pool.query<{ ai_owned: boolean | null; recent: boolean }>(
        `SELECT (SELECT COALESCE(LOWER(handled_by), 'ai') = 'ai' AND COALESCE(LOWER(takeover_state), 'none') = 'none'
                   FROM conversations WHERE id = $1) AS ai_owned,
                EXISTS (SELECT 1 FROM messages
                         WHERE conversation_id = $1 AND role = 'ai' AND message_type = 'sticker'
                           AND created_at >= NOW() - ($2::int * INTERVAL '1 minute')) AS recent`,
        [conversationId, STICKER_MIN_INTERVAL_MINUTES]
      );
      return rows[0]?.ai_owned !== false && (!throttled || rows[0]?.recent !== true);
    } catch (err: any) {
      logger.warn({ error: err.message, conversationId }, "Sticker gate failed; sending without a sticker");
      return false;
    }
  }

  /** Writes a sent sticker to the conversation (admin view + the rate window). */
  async recordSticker(conversationId: number, sticker: LineSticker): Promise<void> {
    await pool
      .query(
        `INSERT INTO messages (conversation_id, role, content, message_type, message_purpose, created_at)
         VALUES ($1, 'ai', $2, 'sticker', 'notification', NOW())`,
        [conversationId, stickerRecord(sticker)]
      )
      .catch((err) => logger.warn({ error: err.message, conversationId }, "Could not record sent sticker"));
  }

  private async appendToConversation(conversationId: number, text: string): Promise<number | null> {
    try {
      const res = await pool.query(
        `INSERT INTO messages (conversation_id, role, content, message_type, message_purpose, created_at)
         VALUES ($1, 'ai', $2, 'text', 'notification', NOW())
         RETURNING id`,
        [conversationId, text]
      );
      return res.rows[0]?.id ? Number(res.rows[0].id) : null;
    } catch (err: any) {
      logger.warn({ error: err.message, conversationId }, "Could not append notification to conversation");
      return null;
    }
  }
}

export const customerNotificationService = new CustomerNotificationService();
