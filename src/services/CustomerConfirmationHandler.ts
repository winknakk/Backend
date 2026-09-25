import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";
import {
  detectConfirmationIntent,
  detectCloseIntent,
  detectCancelIntent,
  detectReopenScope,
  detectReopenConfirmation,
  isBareShortAnswer,
  isDeclineReopen,
  isExplicitDeclineCancel,
  isExplicitDeclineClose,
  TICKET_NUMBER_PATTERN,
  NEW_ISSUE_PATTERN,
  SAME_ISSUE_PATTERN,
  SYMPTOM_PATTERN,
  type ConfirmationIntent,
  type ReopenScope,
} from "../domain/ticket/CustomerConfirmation";
import { closedReferenceChips } from "./LineCaseContextService";
import { ticketStateMachine } from "../domain/ticket/TicketStateMachine";
import { isPendingCreatePrompt } from "../domain/case/PendingIntake";
import type { TicketLifecycleStatus } from "../domain/ticket/TicketLifecycle";
import {
  CustomerNotificationService,
  customerNotificationService,
  type CustomerNotificationType,
  type NotificationQuickReply,
} from "./CustomerNotificationService";
import { cancelAlertService, doneEmailService, reopenAlertService } from "./UrgentAlertService";
import { conversationFocusService } from "./ConversationFocusService";

const logger = createLogger("customer-confirmation");

export interface ConfirmationOutcome {
  handled: boolean;
  ticketId?: number;
  from?: string;
  to?: string;
  reason?: string;
}

interface OpenTicket {
  id: number;
  ticket_number: string | null;
  subject: string | null;
  status: string;
  priority: string | null;
  project_id: number | null;
  org_id: string | null;
  reopened_count: number | null;
  last_reopened_at: Date | null;
  closed_at: Date | null;
}

/** A bare "ยืนยัน" / "ยังไม่ปิด" only answers a question asked this recently. */
const CLOSE_QUESTION_WINDOW_MINUTES = 30;

/** Most cases the "which case" list shows; the chips carry the numbers. */
const WHICH_CASE_LIMIT = 5;

/**
 * Legal route from each lifecycle status to CLOSED, hop by hop. The customer
 * performs the two hops that are theirs (RESOLVED→CUSTOMER_CONFIRMED and
 * CUSTOMER_CONFIRMED→CLOSED); the system walks any engineering hops needed
 * to get there, each recorded with a reason, so a ticket closed at the
 * customer's request still has an honest event trail.
 */
const ROUTE_TO_CLOSED: Record<string, TicketLifecycleStatus[]> = {
  NEW: ["IN_PROGRESS", "RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"],
  TRIAGED: ["IN_PROGRESS", "RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"],
  OPEN: ["RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"],
  IN_PROGRESS: ["RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"],
  WAITING_CUSTOMER: ["RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"],
  WAITING_INTERNAL: ["RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"],
  REOPENED: ["RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"],
  RESOLVED: ["CUSTOMER_CONFIRMED", "CLOSED"],
  CUSTOMER_CONFIRMED: ["CLOSED"],
};

type PendingKind = "close" | "which_case" | "reopen" | "scope" | "cancel" | "cancel_which_case" | "create";

interface PendingQuestion {
  kind: PendingKind;
  ticketNumber: string | null;
  /** True when nothing the AI said since has moved the conversation on. */
  strict: boolean;
}

/** Ledger types that ask the customer something, and which answer they wait for. */
const QUESTION_KINDS: Partial<Record<string, PendingKind>> = {
  close_confirmation_request: "close",
  close_which_case: "which_case",
  reopen_which_kind: "scope",
  reopen_confirmation_request: "reopen",
  cancel_confirmation_request: "cancel",
  cancel_which_case: "cancel_which_case",
};

/** Ledger rows that neither ask nor settle anything; they never hide a pending question. */
const PASSIVE_NOTIFICATION_TYPES: string[] = [
  "acknowledgement",
  "acknowledgement_action",
  "acknowledgement_edit",
  "acknowledgement_choice",
  "greeting",
  "thanks",
  "progress_update",
  "due_extension_notice",
  "image_attached",
  "image_need_context",
  "image_auto_attached",
  "image_auto_attach_pending",
  "unsupported_file",
  "ai_timeout_fallback",
  "sticker_reply",
  "sticker_reminder",
];

/** Pending questions whose chips a sticker reminder can rebuild (2026-09-24). */
const REMINDER_TYPES: Partial<Record<PendingKind, CustomerNotificationType>> = {
  close: "close_confirmation_request",
  cancel: "cancel_confirmation_request",
  scope: "reopen_which_kind",
  reopen: "reopen_confirmation_request",
};

/** How long a question makes its confirmation chip valid — the sticky-chip window. */
const ASKED_WINDOW_HOURS = 24;

/**
 * The protocol question an AI-flow reply asks, read from its wording (the
 * flow's own close / re-open questions and the create card have no ledger row).
 */
function flowQuestion(content: string): { kind: PendingKind; ticketNumber: string | null } | null {
  if (!content) return null;
  const m = content.match(TICKET_NUMBER_PATTERN);
  const num = m ? m[0].toUpperCase() : null;
  if (/ยกเลิกเคสไหน/.test(content)) return { kind: "cancel_which_case", ticketNumber: null };
  if (/ต้องการยกเลิกเคส|ยืนยันยกเลิกเคส|ยกเลิกเคส[^\n]{0,200}ใช่ไหม|ระบบตรวจพบคำขอยกเลิกเคส/.test(content)) return { kind: "cancel", ticketNumber: num };
  if (/(?:ปัญหาเดิม|อาการเดิม)[^\n]{0,200}ปัญหาใหม่/.test(content)) return { kind: "scope", ticketNumber: num };
  if (/ปิดเคสไหน|แตะเลือกข้างล่างนี้|แตะเลือกได้เลย/.test(content)) return { kind: "which_case", ticketNumber: null };
  if (/ยืนยันเปิดเคสอีกครั้ง|CONFIRM_REOPEN_PENDING|เปิดเคส[^\n]{0,200}อีกครั้งใช่ไหม/.test(content)) return { kind: "reopen", ticketNumber: num };
  if (/ต้องการปิดเคส|ยืนยันปิดเคส|CONFIRM_CLOSE_PENDING|ปิดเคส[^\n]{0,200}ใช่ไหม/.test(content)) return { kind: "close", ticketNumber: num };
  // The AI gate's create-confirmation prompt or its "which part to change?"
  // question (markers shared with the LINE case-context guard and the flow's
  // deterministic net — `domain/case/PendingIntake.ts`): while it is pending,
  // "ยกเลิกเคส" without a number means the draft, which the gate's CANCEL_RESET owns.
  if (isPendingCreatePrompt(content)) return { kind: "create", ticketNumber: num };
  return null;
}

/**
 * Two-step close and the re-open path, decided by the customer alone and
 * never by the LLM.
 *
 * Runs before the AI on every inbound text. It engages only for messages
 * that are answers in the protocol — the delivery chips, the close /
 * re-open question chips, a "ปิดเคส" request, feedback right after a
 * re-open — and returns handled=false for everything else, which then flows
 * to the AI untouched.
 *
 *   Plane: Delivery to Customer  → "ทีมงานแก้ไขแล้ว รบกวนทดสอบ"  [ใช้งานได้แล้ว | ยังมีปัญหาอยู่]
 *   ใช้งานได้แล้ว / ปิดเคส        → CUSTOMER_CONFIRMED + "ต้องการปิดเคส … ใช่ไหมคะ"  [ยืนยันปิดเคส | ยังไม่ปิด | ยังมีปัญหาอยู่]
 *   ยืนยันปิดเคส <TCK>           → CLOSED (Plane → Close) + "ปิดเคสเรียบร้อย" + Done email
 *   ยังไม่ปิด                    → back to RESOLVED, nothing closes
 *   ยังมีปัญหาอยู่ / "ใช้ได้แล้ว แต่…" → asks which  [ปัญหาเดิม | ปัญหาใหม่]
 *   ปัญหาเดิม                    → REOPENED, stays there for engineering (Plane → Re-Open),
 *                                  next messages within 30 min become Plane comments, dev email;
 *                                  priority and the original SLA are kept
 *   ปัญหาใหม่                    → old case CLOSED as done, intake starts over (new case, new SLA)
 *   "มีอีกปัญหา…" typed as a report → left to the AI: new case (force_new), old case keeps waiting
 *   ยังมีปัญหาอยู่ <closed TCK>   → re-opened when closed ≤ REOPEN_AFTER_CLOSE_DAYS ago, else a new case
 *   ปิดเคส with nothing open     → "ไม่มีเคสที่เปิดอยู่" at the edge, no AI turn
 *   ยกเลิกเคส [TCK]              → "ต้องการยกเลิกเคส … ใช่ไหมคะ"  [ยืนยันยกเลิกเคส | ไม่ยกเลิก]   (Flow 5, 2026-09-17)
 *   ยืนยันยกเลิกเคส <TCK>        → CANCELLED (Plane → Cancelled via outbox) + "ยกเลิกเคสแล้ว" + dev email,
 *                                  focus (active_ticket_id) released; a RESOLVED case is offered the close question instead
 */
export class CustomerConfirmationHandler {
  private static readonly TICKET_COLUMNS =
    "id, ticket_number, subject, status, priority, project_id, org_id, reopened_count, last_reopened_at, closed_at";

  /** Every non-terminal ticket of the conversation, newest activity first. */
  private async loadOpenTickets(conversationId: number): Promise<OpenTicket[]> {
    const { rows } = await pool.query<OpenTicket>(
      `SELECT ${CustomerConfirmationHandler.TICKET_COLUMNS}
         FROM tickets
        WHERE conversation_id = $1
          AND deleted_at IS NULL
          AND UPPER(COALESCE(status, '')) NOT IN ('CLOSED', 'CANCELLED')
        ORDER BY lifecycle_changed_at DESC NULLS LAST, id DESC`,
      [conversationId]
    );
    return rows.map((r) => ({ ...r, status: String(r.status || "").toUpperCase() }));
  }

  /** Closed tickets still inside the re-open window (operator: 7 days). */
  private async loadRecentlyClosed(conversationId: number): Promise<OpenTicket[]> {
    const days = config.REOPEN_AFTER_CLOSE_DAYS;
    if (days <= 0) return [];
    const { rows } = await pool.query<OpenTicket>(
      `SELECT ${CustomerConfirmationHandler.TICKET_COLUMNS}
         FROM tickets
        WHERE conversation_id = $1
          AND deleted_at IS NULL
          AND UPPER(COALESCE(status, '')) = 'CLOSED'
          AND closed_at >= NOW() - ($2::int * INTERVAL '1 day')
        ORDER BY closed_at DESC, id DESC`,
      [conversationId, days]
    );
    return rows.map((r) => ({ ...r, status: "CLOSED" }));
  }

  /** A closed ticket named in the text, however long ago it was closed. */
  private async loadClosedByNumber(conversationId: number, ticketNumber: string): Promise<OpenTicket | null> {
    const { rows } = await pool.query<OpenTicket>(
      `SELECT ${CustomerConfirmationHandler.TICKET_COLUMNS}
         FROM tickets
        WHERE conversation_id = $1 AND deleted_at IS NULL AND UPPER(ticket_number) = $2
          AND UPPER(COALESCE(status, '')) IN ('CLOSED', 'CANCELLED')
        LIMIT 1`,
      [conversationId, ticketNumber.toUpperCase()]
    );
    return rows[0] ? { ...rows[0], status: String(rows[0].status).toUpperCase() } : null;
  }

  /**
   * The question the customer owes an answer to, if any.
   *
   * Backend questions are read from the notification ledger by TYPE, never by
   * wording (2026-09-24): the old wording regexes mistook one "ปัญหาเดิม /
   * ปัญหาใหม่" variant for the close list (H3) and missed the close question
   * whenever a long subject sat between "ปิดเคส" and "ใช่ไหม" (H4). Receipts
   * and status pushes (Fast Ack, SLA progress) never hide a question (H5).
   *
   * Questions asked by the AI flow (its close / re-open questions, the create
   * confirmation card) exist only as reply text and keep the wording rules.
   *
   * `strict` = nothing the AI said since has moved the conversation on. Only
   * a strict question takes a bare "ใช่" / "ไม่" (seen live 2026-09-08: a stale
   * close question made a "ยืนยัน" meant for a create confirmation close the
   * wrong case); an explicit "ยังไม่ปิด" / "ไม่ยกเลิก" also answers a loose one.
   */
  private async pendingQuestion(conversationId: number): Promise<PendingQuestion | null> {
    const [ledgerRes, replyRes] = await Promise.all([
      pool.query<{ notification_type: string; ticket_number: string | null; created_at: Date }>(
        `SELECT n.notification_type, t.ticket_number, n.created_at
           FROM customer_notifications n
           LEFT JOIN tickets t ON t.id = n.ticket_id
          WHERE n.conversation_id = $1
            AND n.status = 'sent'
            AND n.created_at >= NOW() - ($2::int * INTERVAL '1 minute')
            AND n.notification_type <> ALL($3::text[])
          ORDER BY n.id DESC LIMIT 1`,
        [conversationId, CLOSE_QUESTION_WINDOW_MINUTES, PASSIVE_NOTIFICATION_TYPES]
      ),
      pool.query<{ content: string; created_at: Date }>(
        `SELECT content, created_at FROM messages
          WHERE conversation_id = $1 AND role = 'ai'
            AND COALESCE(message_purpose, '') <> 'notification'
            AND created_at >= NOW() - ($2::int * INTERVAL '1 minute')
          ORDER BY id DESC LIMIT 1`,
        [conversationId, CLOSE_QUESTION_WINDOW_MINUTES]
      ),
    ]);
    const row = ledgerRes.rows[0];
    const reply = replyRes.rows[0];
    const ledgerKind = row ? QUESTION_KINDS[row.notification_type] ?? null : null;
    const ledgerQuestion = ledgerKind
      ? { kind: ledgerKind, ticketNumber: row?.ticket_number ? String(row.ticket_number).toUpperCase() : null }
      : null;
    const replyIsNewer = Boolean(reply && (!row || new Date(reply.created_at).getTime() > new Date(row.created_at).getTime()));
    if (replyIsNewer) {
      const asked = flowQuestion(String(reply?.content || ""));
      if (asked) return { ...asked, strict: true };
      return ledgerQuestion ? { ...ledgerQuestion, strict: false } : null;
    }
    return ledgerQuestion ? { ...ledgerQuestion, strict: true } : null;
  }

  /**
   * The chips of the question the customer still owes an answer to, for the
   * reminder sent when they reply with a sticker instead (2026-09-24).
   * null = nothing pending; [] = something pending whose chips cannot be
   * rebuilt here (a case list, the AI's create summary) — stay silent.
   * A sticker is never read as the answer itself.
   */
  async pendingReminderChips(conversationId: number): Promise<NotificationQuickReply[] | null> {
    const pending = await this.pendingQuestion(conversationId);
    if (pending) {
      const type = pending.strict ? REMINDER_TYPES[pending.kind] : undefined;
      return type ? CustomerNotificationService.defaultQuickReplies(type, pending.ticketNumber) : [];
    }
    // The delivery card: its question has no PendingKind, it stands while the
    // case is still RESOLVED and nothing newer was asked.
    const { rows } = await pool.query<{ notification_type: string; ticket_number: string | null; status: string | null }>(
      `SELECT n.notification_type, t.ticket_number, UPPER(t.status) AS status
         FROM customer_notifications n
         LEFT JOIN tickets t ON t.id = n.ticket_id
        WHERE n.conversation_id = $1
          AND n.status = 'sent'
          AND n.created_at >= NOW() - ($2::int * INTERVAL '1 hour')
          AND n.notification_type <> ALL($3::text[])
        ORDER BY n.id DESC LIMIT 1`,
      [conversationId, ASKED_WINDOW_HOURS, PASSIVE_NOTIFICATION_TYPES]
    );
    const row = rows[0];
    if (row && (row.notification_type === "resolution_confirmation" || row.notification_type === "resolution_nudge") && row.status === "RESOLVED") {
      return CustomerNotificationService.defaultQuickReplies("resolution_confirmation", row.ticket_number);
    }
    return null;
  }

  /**
   * Whether this exact case was actually asked the question that its
   * confirmation chip answers, after its last status change and within the
   * sticky-chip window (H8 / H10). Typed "ยืนยันปิดเคส <TCK>" on a case nobody
   * asked about, or one engineering has moved since, gets the question first.
   */
  private async wasAsked(conversationId: number, ticket: OpenTicket, kind: "close" | "cancel" | "reopen"): Promise<boolean> {
    const type: CustomerNotificationType =
      kind === "close" ? "close_confirmation_request" : kind === "cancel" ? "cancel_confirmation_request" : "reopen_confirmation_request";
    try {
      const ledger = await pool.query(
        `SELECT 1 FROM customer_notifications n
           JOIN tickets t ON t.id = n.ticket_id
          WHERE n.conversation_id = $1 AND n.ticket_id = $2 AND n.notification_type = $3
            AND n.status = 'sent'
            AND n.created_at >= NOW() - ($4::int * INTERVAL '1 hour')
            AND n.created_at >= COALESCE(t.lifecycle_changed_at, '-infinity'::timestamptz)
          LIMIT 1`,
        [conversationId, ticket.id, type, ASKED_WINDOW_HOURS]
      );
      if (ledger.rows.length > 0) return true;
      if (!ticket.ticket_number) return false;
      // The AI flow asks its own close / re-open questions; those live only as reply text.
      const replies = await pool.query<{ content: string }>(
        `SELECT m.content FROM messages m
           JOIN tickets t ON t.id = $2
          WHERE m.conversation_id = $1 AND m.role = 'ai'
            AND COALESCE(m.message_purpose, '') <> 'notification'
            AND m.created_at >= NOW() - ($3::int * INTERVAL '1 hour')
            AND m.created_at >= COALESCE(t.lifecycle_changed_at, '-infinity'::timestamptz)
            AND POSITION(UPPER($4) IN UPPER(m.content)) > 0
          ORDER BY m.id DESC LIMIT 5`,
        [conversationId, ticket.id, ASKED_WINDOW_HOURS, ticket.ticket_number]
      );
      return replies.rows.some((r) => flowQuestion(String(r.content || ""))?.kind === kind);
    } catch (err: any) {
      logger.warn({ ticketId: ticket.id, kind, error: err.message }, "Could not check whether the question was asked; asking again");
      return false;
    }
  }

  private notify(
    input: { conversationId: number; correlationId?: string },
    ticket: OpenTicket | null,
    notificationType: CustomerNotificationType,
    idempotencyKey: string,
    extra: { detail?: string; quickReplies?: { label: string; text: string }[] } = {}
  ) {
    return customerNotificationService.send({
      conversationId: input.conversationId,
      notificationType,
      idempotencyKey,
      ticketId: ticket?.id ?? null,
      ticketNumber: ticket?.ticket_number ?? null,
      subject: ticket?.subject ?? null,
      projectId: ticket?.project_id ?? null,
      orgId: ticket?.org_id ?? null,
      correlationId: input.correlationId,
      detail: extra.detail ?? null,
      quickReplies: extra.quickReplies,
    });
  }

  /** Per-LINE-event key: a webhook retry must not re-send the question. */
  private eventKey(input: { conversationId: number; correlationId?: string }, tag: string): string {
    return `${input.correlationId || `conv:${input.conversationId}:${Date.now()}`}:${tag}`;
  }

  /** "Which case?" — the list plus one chip per case, each chip a full close request. */
  private async askWhichCase(input: { conversationId: number; correlationId?: string }, tickets: OpenTicket[]): Promise<ConfirmationOutcome> {
    const shown = tickets.slice(0, WHICH_CASE_LIMIT);
    const lines = shown.map((t) => {
      const subject = String(t.subject || "").trim();
      const short = subject.length > 60 ? `${subject.slice(0, 60)}…` : subject;
      return `• ${t.ticket_number || `#${t.id}`}${short ? ` – ${short}` : ""}`;
    });
    await this.notify(input, null, "close_which_case", this.eventKey(input, "which_case"), {
      detail: lines.join("\n"),
      quickReplies: shown
        .filter((t) => t.ticket_number)
        .map((t) => ({ label: String(t.ticket_number).slice(0, 20), text: `ปิดเคส ${t.ticket_number}` })),
    });
    return { handled: true, reason: "CLOSE_WHICH_CASE" };
  }

  /**
   * Asks "ต้องการปิดเคส … ใช่ไหมคะ". A RESOLVED ticket moves to
   * CUSTOMER_CONFIRMED here (the customer has just said it works); any other
   * status is left alone until the confirmation chip.
   */
  private async askClose(input: { conversationId: number; correlationId?: string }, ticket: OpenTicket): Promise<ConfirmationOutcome> {
    let from = ticket.status;
    if (ticket.status === "RESOLVED") {
      const r = await ticketStateMachine.transition({
        ticketRef: ticket.id,
        to: "CUSTOMER_CONFIRMED",
        actor: "customer",
        actorRef: `conversation:${input.conversationId}`,
        reason: "Customer reports the fix works; awaiting close confirmation",
        correlationId: input.correlationId,
        source: "customer_reply",
      });
      if (!r.applied) logger.warn({ ticketId: ticket.id, code: r.code }, "Could not mark ticket CUSTOMER_CONFIRMED");
      else from = "RESOLVED";
    }
    await this.notify(input, ticket, "close_confirmation_request", this.eventKey(input, `close_ask:${ticket.id}`));
    return { handled: true, ticketId: ticket.id, from, to: ticket.status === "RESOLVED" ? "CUSTOMER_CONFIRMED" : ticket.status, reason: "CLOSE_QUESTION_ASKED" };
  }

  /** "Same problem or a new one?" — two chips decide (operator decision 2026-09-08: always ask). */
  private async askScope(input: { conversationId: number; correlationId?: string }, ticket: OpenTicket, tag = "which_kind"): Promise<ConfirmationOutcome> {
    await this.notify(input, ticket, "reopen_which_kind", this.eventKey(input, tag));
    return { handled: true, ticketId: ticket.id, reason: "REOPEN_SCOPE_ASKED" };
  }

  /**
   * Several delivered cases and an answer that names none (H1): ask which,
   * one chip per case carrying the same answer with the number attached.
   * Picking the newest one used to close or re-open a case the customer
   * never meant.
   */
  private async askWhichAwaiting(
    input: { conversationId: number; correlationId?: string },
    awaiting: OpenTicket[],
    scope: ReopenScope,
    intent: ConfirmationIntent
  ): Promise<ConfirmationOutcome> {
    const shown = awaiting.slice(0, WHICH_CASE_LIMIT);
    const answer = scope === "NEW" ? "ปัญหาใหม่" : intent === "CONFIRMED" && scope === "NONE" ? "ใช้งานได้แล้ว" : "ยังมีปัญหาอยู่";
    const lines = shown.map((t) => {
      const subject = String(t.subject || "").trim();
      const short = subject.length > 60 ? `${subject.slice(0, 60)}…` : subject;
      return `• ${t.ticket_number || `#${t.id}`}${short ? ` – ${short}` : ""}`;
    });
    await this.notify(input, null, "resolution_which_case", this.eventKey(input, "resolution_which_case"), {
      detail: lines.join("\n"),
      quickReplies: shown
        .filter((t) => t.ticket_number)
        .map((t) => ({ label: String(t.ticket_number).slice(0, 20), text: `${answer} ${t.ticket_number}` })),
    });
    return { handled: true, reason: "RESOLUTION_WHICH_CASE" };
  }

  /**
   * A delivery-style answer about a case that is not waiting on the customer
   * (engineering pulled it back, or it was never delivered). Answered for
   * that case only — never redirected to another one (H1).
   */
  private async answerCaseInProgress(
    input: { conversationId: number; correlationId?: string },
    ticket: OpenTicket,
    text: string,
    scope: ReopenScope,
    intent: ConfirmationIntent
  ): Promise<ConfirmationOutcome> {
    if (intent === "CONFIRMED" && scope === "NONE") return this.askClose(input, ticket);
    if (scope === "SAME" || scope === "AMBIGUOUS" || intent === "REJECTED") {
      const feedback = this.feedbackFrom(text);
      if (feedback) await this.saveFeedback(input, ticket, feedback, ticket.reopened_count ?? null, "comment");
      const num = ticket.ticket_number || `#${ticket.id}`;
      await this.notify(input, ticket, "case_context", this.eventKey(input, "case_in_progress"), {
        detail: `เคส ${num} ทีมงานยังดำเนินการอยู่ค่ะ ${feedback ? "แอดมินส่งรายละเอียดที่แจ้งมาให้ทีมงานแล้วนะคะ " : ""}มีความคืบหน้าจะรีบแจ้งให้ทราบค่ะ หากมีรายละเอียดเพิ่มเติม พิมพ์เล่ามาได้เลยนะคะ`,
        quickReplies: [],
      });
      return { handled: true, ticketId: ticket.id, reason: "CASE_STILL_IN_PROGRESS" };
    }
    return { handled: false, reason: "OPEN_CASE_NO_PROTOCOL_INTENT" };
  }

  /**
   * "ปัญหาใหม่" about a case that is already closed: nothing to close — ask
   * for the new report. `new_case_prompt` opens the new-case window, so the
   * next message is filed as a new case rather than matched to an old one.
   */
  private async promptNewIssue(input: { conversationId: number; correlationId?: string }, ended: OpenTicket): Promise<ConfirmationOutcome> {
    await customerNotificationService.send({
      conversationId: input.conversationId,
      notificationType: "new_case_prompt",
      idempotencyKey: this.eventKey(input, "new_issue_prompt"),
      projectId: ended.project_id ?? null,
      orgId: ended.org_id ?? null,
      correlationId: input.correlationId,
      quickReplies: [],
    });
    return { handled: true, ticketId: ended.id, reason: "NEW_ISSUE_PROMPTED" };
  }

  /**
   * The answer for a case that has already ended. A cancelled case is never
   * re-opened and must not be told "ปิดไปเกิน 7 วัน" (H9, operator decision
   * 2026-09-18); it is offered a new case made from it instead.
   */
  private async answerEndedCase(
    input: { conversationId: number; correlationId?: string },
    ended: OpenTicket,
    purpose: "reopen" | "close"
  ): Promise<ConfirmationOutcome> {
    const num = ended.ticket_number || `#${ended.id}`;
    if (String(ended.status).toUpperCase() === "CANCELLED") {
      await this.notify(input, ended, "case_context", this.eventKey(input, "cancelled_case"), {
        detail: `เคส ${num} ถูกยกเลิกไปแล้วค่ะ ระบบเปิดเคสที่ยกเลิกแล้วกลับมาไม่ได้ หากยังพบปัญหาอยู่ แตะ "เปิดเคสใหม่จากเรื่องนี้" หรือเล่าอาการที่เจอมาได้เลยนะคะ`,
        quickReplies: closedReferenceChips(ended.ticket_number, ended.closed_at, config.REOPEN_AFTER_CLOSE_DAYS, "CANCELLED"),
      });
      return { handled: true, ticketId: ended.id, reason: "CASE_CANCELLED" };
    }
    if (purpose === "reopen") {
      await this.notify(input, ended, "reopen_too_old", this.eventKey(input, "reopen_too_old"), { detail: String(config.REOPEN_AFTER_CLOSE_DAYS), quickReplies: [] });
      return { handled: true, ticketId: ended.id, reason: "REOPEN_TOO_OLD" };
    }
    await this.notify(input, ended, "case_context", this.eventKey(input, "already_closed"), {
      detail: `เคส ${num} ปิดเรียบร้อยแล้วค่ะ`,
      quickReplies: [],
    });
    return { handled: true, ticketId: ended.id, reason: "ALREADY_CLOSED" };
  }

  /**
   * A customer action the state machine refused (H6). The turn stays handled
   * and the customer is told what really happened: handing "ยืนยันยกเลิกเคส
   * <TCK>" to the AI let it announce a cancel that never happened (2026-09-18).
   */
  private async transitionRefused(
    input: { conversationId: number; correlationId?: string },
    ticket: OpenTicket,
    action: "close" | "cancel" | "reopen",
    code?: string
  ): Promise<ConfirmationOutcome> {
    logger.warn({ ticketId: ticket.id, from: ticket.status, action, code }, "Customer action refused by the state machine; answered at the edge");
    const fresh = await pool
      .query<{ status: string }>(`SELECT UPPER(COALESCE(status, '')) AS status FROM tickets WHERE id = $1`, [ticket.id])
      .then((r) => String(r.rows[0]?.status || ""))
      .catch(() => "");
    if (action === "cancel" && (fresh === "RESOLVED" || fresh === "CUSTOMER_CONFIRMED")) {
      // Delivered in the meantime: not cancellable, so offer the close question.
      return this.askClose(input, { ...ticket, status: fresh });
    }
    if (action !== "reopen" && (fresh === "CLOSED" || fresh === "CANCELLED")) {
      return this.answerEndedCase(input, { ...ticket, status: fresh }, "close");
    }
    await this.notify(input, ticket, "action_failed", this.eventKey(input, `action_failed:${action}`), { quickReplies: [] });
    return { handled: true, ticketId: ticket.id, from: ticket.status, reason: `TRANSITION_REFUSED: ${code || "UNKNOWN"}` };
  }

  /** Walks the ticket to CLOSED along ROUTE_TO_CLOSED and tells the customer. */
  private async closeTicket(
    input: { conversationId: number; correlationId?: string },
    ticket: OpenTicket,
    notifyAs: "closed" | "reopen_new_issue_prompt" = "closed"
  ): Promise<ConfirmationOutcome> {
    if (!ticket || !ticket.id) {
      return { handled: false, reason: "NO_TARGET_TICKET" };
    }
    if (["CLOSED", "CANCELLED"].includes(ticket.status)) {
      return { handled: true, ticketId: ticket.id, reason: "ALREADY_CLOSED" };
    }
    const route = ROUTE_TO_CLOSED[ticket.status];
    if (!route) {
      logger.warn({ ticketId: ticket.id, status: ticket.status }, "No close route for ticket status");
      return this.transitionRefused(input, ticket, "close", "NO_CLOSE_ROUTE");
    }
    let current: string = ticket.status;
    let closedEventId: number | null = null;
    for (const next of route) {
      const customerHop = (current === "RESOLVED" && next === "CUSTOMER_CONFIRMED") || (current === "CUSTOMER_CONFIRMED" && next === "CLOSED");
      const r = await ticketStateMachine.transition({
        ticketRef: ticket.id,
        to: next,
        actor: customerHop ? "customer" : "system",
        actorRef: customerHop ? `conversation:${input.conversationId}` : "confirmation-handler",
        reason: customerHop
          ? next === "CLOSED" ? "Customer confirmed the close question" : "Customer confirmed the fix works"
          : `Closed at the customer's request (engineering hop ${current} -> ${next})`,
        correlationId: input.correlationId,
        source: "customer_reply",
      });
      if (!r.applied) {
        logger.warn({ ticketId: ticket.id, from: current, to: next, code: r.code }, "Close route hop rejected");
        return this.transitionRefused(input, ticket, "close", r.code);
      }
      current = next;
      if (next === "CLOSED") closedEventId = r.eventId ?? null;
    }

    await this.notify(input, ticket, notifyAs, closedEventId ? `ticket_event:${closedEventId}` : `ticket:${ticket.id}:closed`, { quickReplies: [] });
    // A closed case must not stay the conversation's focus (spec v2 Flow 3 step 7).
    void conversationFocusService.releaseTerminalTicket(ticket.id).catch(() => {});
    // Customer "Done" email (Gmail via the notification flow), originated here
    // because Plane's own webhook never arrives (ISSUE-053). Fire-and-forget.
    void doneEmailService.notifyClosed({ ticketId: ticket.id, closeEventId: closedEventId, correlationId: input.correlationId }).catch(() => {});
    logger.info({ ticketId: ticket.id, conversationId: input.conversationId, correlationId: input.correlationId, from: ticket.status }, "Ticket closed by customer confirmation");
    return { handled: true, ticketId: ticket.id, from: ticket.status, to: "CLOSED" };
  }

  // ---------------------------------------------------------------------------
  // Re-open path (operator decisions 2026-09-08)
  // ---------------------------------------------------------------------------

  /**
   * Appends customer feedback to the ticket and mirrors it to Plane: always a
   * comment, and (`mirror` = "comment+description") also as a symptom line
   * under the current round header in the description. `reopenTicket` passes
   * "comment" because it writes the description itself.
   */
  private async saveFeedback(
    input: { conversationId: number; correlationId?: string },
    ticket: OpenTicket,
    text: string,
    reopenedCount: number | null,
    mirror: "comment" | "comment+description" = "comment+description"
  ): Promise<void> {
    const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 2000);
    if (!clean) return;
    await pool
      .query(
        `UPDATE tickets
            SET running_summary = COALESCE(running_summary, '') || E'\n[' || TO_CHAR(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') || ' ลูกค้า] ' || $2,
                updated_at = NOW()
          WHERE id = $1`,
        [ticket.id, clean]
      )
      .catch((err) => logger.warn({ ticketId: ticket.id, error: err.message }, "Could not append feedback to running_summary"));
    await pool
      .query(
        `INSERT INTO ticket_events (ticket_id, event_type, actor, payload, correlation_id, source, created_at)
         VALUES ($1, 'CUSTOMER_FEEDBACK', $2, $3, $4, 'customer_reply', NOW())`,
        [ticket.id, `conversation:${input.conversationId}`, JSON.stringify({ text: clean, reopenedCount }), input.correlationId || null]
      )
      .catch((err) => logger.warn({ ticketId: ticket.id, error: err.message }, "Could not record CUSTOMER_FEEDBACK event"));
    // Plane comment: lazy import keeps the webhook path free of the Plane
    // service graph, and a Plane failure never blocks the customer reply.
    void (async () => {
      try {
        const { PlaneService } = await import("./planeService");
        const { AdapterFactory } = await import("../adapters/AdapterFactory");
        const planeService = new PlaneService(AdapterFactory.getAdapter());
        await planeService.addCustomerFeedbackComment(ticket.id, clean, { ticketNumber: ticket.ticket_number, reopenedCount });
        if (mirror === "comment+description") {
          await planeService.markWorkItemReopened(ticket.id, { ticketNumber: ticket.ticket_number, reopenedCount, feedback: clean });
        }
      } catch (err: any) {
        logger.warn({ ticketId: ticket.id, error: err?.message }, "Plane feedback comment failed");
      }
    })();
  }

  /**
   * Same bug: RESOLVED / CUSTOMER_CONFIRMED / CLOSED → REOPENED and it stays
   * there (Plane → Re-Open) until engineering moves it. `feedback` is the
   * customer's own description when the message carried one.
   */
  private async reopenTicket(input: { conversationId: number; correlationId?: string }, ticket: OpenTicket, feedback: string | null): Promise<ConfirmationOutcome> {
    const reopened = await ticketStateMachine.transition({
      ticketRef: ticket.id,
      to: "REOPENED",
      actor: "customer",
      actorRef: `conversation:${input.conversationId}`,
      reason: "Customer reported the issue is still present",
      correlationId: input.correlationId,
      source: "customer_reply",
    });
    if (!reopened.applied) {
      logger.warn({ ticketId: ticket.id, code: reopened.code }, "Customer rejection could not be applied");
      return this.transitionRefused(input, ticket, "reopen", reopened.code);
    }
    const countRow = await pool.query<{ reopened_count: number | null }>(`SELECT reopened_count FROM tickets WHERE id = $1`, [ticket.id]).catch(() => null);
    const count = Number(countRow?.rows?.[0]?.reopened_count || 1);

    if (feedback) await this.saveFeedback(input, ticket, feedback, count, "comment");
    // Plane: "Re-Open" label + a round header on top of the description so the
    // engineer sees this is the same bug coming back. Never blocks the reply.
    void (async () => {
      try {
        const { PlaneService } = await import("./planeService");
        const { AdapterFactory } = await import("../adapters/AdapterFactory");
        const planeService = new PlaneService(AdapterFactory.getAdapter());
        await planeService.markWorkItemReopened(ticket.id, { ticketNumber: ticket.ticket_number, reopenedCount: count, feedback });
      } catch (err: any) {
        logger.warn({ ticketId: ticket.id, error: err?.message }, "Plane reopen marking failed");
      }
    })();

    // No escalation ladder (operator decision 2026-09-08): the case keeps its
    // priority and its original SLA; the round number only appears in the
    // engineers' email.
    const key = reopened.eventId ? `ticket_event:${reopened.eventId}` : `ticket:${ticket.id}:reopened:${count}`;
    // detail "" = the customer already described the symptoms; skip the ask.
    await this.notify(input, ticket, "reopened", key, { quickReplies: [], detail: feedback ? "" : undefined });
    void reopenAlertService.notifyReopened({ ticketId: ticket.id, feedback, correlationId: input.correlationId }).catch(() => {});

    logger.info({ ticketId: ticket.id, conversationId: input.conversationId, correlationId: input.correlationId, count }, "Customer rejected resolution; ticket reopened");
    return { handled: true, ticketId: ticket.id, from: ticket.status, to: "REOPENED" };
  }

  // ---------------------------------------------------------------------------
  // Post-ticket cancel (Flow 5, operator decision 2026-09-17)
  // ---------------------------------------------------------------------------

  /** "ยกเลิกเคสไหน?" — the list plus one chip per case, each chip a full cancel request. */
  private async askWhichCaseToCancel(input: { conversationId: number; correlationId?: string }, tickets: OpenTicket[]): Promise<ConfirmationOutcome> {
    const shown = tickets.slice(0, WHICH_CASE_LIMIT);
    const lines = shown.map((t) => {
      const subject = String(t.subject || "").trim();
      const short = subject.length > 60 ? `${subject.slice(0, 60)}…` : subject;
      return `• ${t.ticket_number || `#${t.id}`}${short ? ` – ${short}` : ""}`;
    });
    await this.notify(input, null, "cancel_which_case", this.eventKey(input, "cancel_which_case"), {
      detail: lines.join("\n"),
      quickReplies: shown
        .filter((t) => t.ticket_number)
        .map((t) => ({ label: String(t.ticket_number).slice(0, 20), text: `ยกเลิกเคส ${t.ticket_number}` })),
    });
    return { handled: true, reason: "CANCEL_WHICH_CASE" };
  }

  /**
   * Asks "ต้องการยกเลิกเคส … ใช่ไหมคะ". Nothing changes until the confirmation
   * chip. The request (and the customer's own reason, when the message carried
   * one) is recorded as a `CANCEL_REQUESTED` event so the confirm step can
   * copy it into `cancellation_reason` (2026-09-18).
   */
  private async askCancel(input: { conversationId: number; correlationId?: string }, ticket: OpenTicket, reason: string | null = null): Promise<ConfirmationOutcome> {
    await pool
      .query(
        `INSERT INTO ticket_events (ticket_id, event_type, actor, source, correlation_id, payload, created_at)
         VALUES ($1, 'CANCEL_REQUESTED', 'customer', 'customer_reply', $2, $3, NOW())`,
        [ticket.id, input.correlationId || null, JSON.stringify({ conversation_id: input.conversationId, reason: reason || null })]
      )
      .catch((err) => logger.warn({ ticketId: ticket.id, error: err.message }, "Could not record CANCEL_REQUESTED"));
    await this.notify(input, ticket, "cancel_confirmation_request", this.eventKey(input, `cancel_ask:${ticket.id}`));
    return { handled: true, ticketId: ticket.id, from: ticket.status, to: ticket.status, reason: "CANCEL_QUESTION_ASKED" };
  }

  /** The reason the customer gave with the most recent cancel request for this case, if any. */
  private async requestedCancelReason(ticketId: number): Promise<string | null> {
    try {
      const { rows } = await pool.query<{ reason: string | null }>(
        `SELECT payload->>'reason' AS reason FROM ticket_events
          WHERE ticket_id = $1 AND event_type = 'CANCEL_REQUESTED' AND COALESCE(payload->>'reason', '') <> ''
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [ticketId]
      );
      return rows[0]?.reason?.trim() || null;
    } catch (err: any) {
      logger.warn({ ticketId, error: err.message }, "Could not read the requested cancel reason");
      return null;
    }
  }

  /**
   * CANCELLED at the customer's request. Plane follows through the existing
   * outbox trigger (tickets status change → PlaneWorkItemUpdateRequested →
   * Cancelled state); the engineers get a "[CANCELLED]" email; the case is
   * dropped as the conversation's focus.
   */
  private async cancelTicket(input: { conversationId: number; correlationId?: string }, ticket: OpenTicket): Promise<ConfirmationOutcome> {
    const r = await ticketStateMachine.transition({
      ticketRef: ticket.id,
      to: "CANCELLED",
      actor: "customer",
      actorRef: `conversation:${input.conversationId}`,
      reason: "Customer asked to cancel the case and confirmed",
      correlationId: input.correlationId,
      source: "customer_reply",
    });
    if (!r.applied) {
      logger.warn({ ticketId: ticket.id, from: ticket.status, code: r.code }, "Customer cancel could not be applied");
      return this.transitionRefused(input, ticket, "cancel", r.code);
    }
    const customerReason = await this.requestedCancelReason(ticket.id);
    await pool
      .query(
        `UPDATE tickets SET cancellation_reason = COALESCE(cancellation_reason, $2), updated_at = NOW() WHERE id = $1`,
        [ticket.id, customerReason ? `ลูกค้าแจ้ง: ${customerReason.slice(0, 500)}` : "Cancelled by the customer (confirmation chip)"]
      )
      .catch((err) => logger.warn({ ticketId: ticket.id, error: err.message }, "Could not record cancellation_reason"));
    await this.notify(input, ticket, "cancelled", r.eventId ? `ticket_event:${r.eventId}` : `ticket:${ticket.id}:cancelled`, { quickReplies: [] });
    void conversationFocusService.releaseTerminalTicket(ticket.id).catch(() => {});
    void cancelAlertService.notifyCancelled({ ticketId: ticket.id, cancelEventId: r.eventId ?? null, correlationId: input.correlationId }).catch(() => {});
    logger.info({ ticketId: ticket.id, conversationId: input.conversationId, correlationId: input.correlationId, from: ticket.status }, "Ticket cancelled by customer confirmation");
    return { handled: true, ticketId: ticket.id, from: ticket.status, to: "CANCELLED" };
  }

  /** The text minus the chip words / case number: what the customer actually said. */
  private feedbackFrom(text: string): string | null {
    const stripped = String(text || "")
      .replace(TICKET_NUMBER_PATTERN, "")
      .replace(/ยังมีปัญหาอยู่|อาการเดิมยังไม่หาย|(?:เป็น)?(?:ปัญหา|เรื่อง|อาการ|อัน|เคส)เดิม|อาการเดิม|ยังมีปัญหา|ยังไม่หาย|ครับ|ค่ะ|คับ|นะคะ|นะครับ/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return stripped.length >= 6 ? String(text).trim() : null;
  }

  /**
   * Returns handled=false when the message is not part of the protocol,
   * which is the common case — the caller then continues with normal
   * processing.
   */
  async handle(input: { conversationId: number; text: string; correlationId?: string }): Promise<ConfirmationOutcome> {
    const text = String(input.text || "");
    const tickets = await this.loadOpenTickets(input.conversationId);
    const activeTicketId = await conversationFocusService.getActiveTicketId(input.conversationId);
    const activeTicket = activeTicketId ? tickets.find((t) => t.id === activeTicketId) ?? null : null;
    // `asked`: the newest question in the last 30 minutes, strict or loose.
    // `pending`: only a strict one — the only kind a bare "ใช่" / "ไม่" answers.
    const asked = await this.pendingQuestion(input.conversationId);
    const pending = asked?.strict ? asked : null;
    const numberInText = (text.match(TICKET_NUMBER_PATTERN)?.[0] || "").toUpperCase() || null;
    const isBareNumber = Boolean(numberInText) && text.replace(TICKET_NUMBER_PATTERN, "").replace(/นะครับ|นะคะ|ครับ|ค่ะ|คับ|จ้า|เคส|\s/g, "") === "";
    // A bare "ใช่" closes only right after the close question itself — never
    // after the "which case" list or the "ปัญหาเดิม / ปัญหาใหม่" question (H3).
    let close = detectCloseIntent(text, pending?.kind === "close");
    if (close.kind === "NONE" && asked?.kind === "close" && isExplicitDeclineClose(text)) {
      close = { kind: "DECLINE_CLOSE", ticketNumber: numberInText, isThisCaseRef: false };
    }
    if (close.kind === "NONE" && pending?.kind === "which_case" && isBareNumber) {
      // The "which case" list answered with just a number.
      close = { kind: "CLOSE_REQUEST", ticketNumber: numberInText, isThisCaseRef: false };
    }
    const byNumber = (n: string | null | undefined, pool_: OpenTicket[] = tickets) =>
      n ? pool_.find((t) => String(t.ticket_number || "").toUpperCase() === n.toUpperCase()) ?? null : null;

    // 0. "ยืนยันเปิดเคสอีกครั้ง [TCK]" — the AI flow's re-open chip. A bare yes
    //    counts only right after that question.
    const reopenConfirm = detectReopenConfirmation(text);
    const bareYesForReopen = pending?.kind === "reopen" && close.kind === "NONE" && /^\s*(?:ยืนยัน|ใช่|โอเค|ok|ตกลง|ได้เลย|เปิดเลย)/i.test(text);
    if (reopenConfirm.confirmed || bareYesForReopen) {
      const wanted = reopenConfirm.ticketNumber || pending?.ticketNumber || null;
      const recent = await this.loadRecentlyClosed(input.conversationId);
      let target = byNumber(wanted) ?? byNumber(wanted, recent);
      if (!target && !wanted) {
        const awaiting = tickets.filter((t) => t.status === "RESOLVED" || t.status === "CUSTOMER_CONFIRMED");
        target = awaiting.length === 1 ? awaiting[0] : recent.length === 1 ? recent[0] : null;
      }
      if (!target && wanted) {
        const old = await this.loadClosedByNumber(input.conversationId, wanted);
        if (old) return this.answerEndedCase(input, old, "reopen");
      }
      if (!target) return { handled: false, reason: "REOPEN_TARGET_NOT_FOUND" };
      if (!["RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"].includes(target.status)) {
        await this.notify(input, target, "acknowledgement_action", this.eventKey(input, "reopen_noop"), { quickReplies: [] });
        return { handled: true, ticketId: target.id, reason: "ALREADY_OPEN" };
      }
      // H10: the chip answers a re-open question. Typed without one, the case
      // is asked "same problem or new?" first (operator decision: always ask).
      if (!bareYesForReopen && !(await this.wasAsked(input.conversationId, target, "reopen"))) {
        return this.askScope(input, target);
      }
      return this.reopenTicket(input, target, null);
    }
    if (pending?.kind === "reopen" && isDeclineReopen(text)) {
      await this.notify(input, null, "acknowledgement_action", this.eventKey(input, "reopen_cancel"), { quickReplies: [] });
      return { handled: true, reason: "REOPEN_CANCELLED" };
    }

    // 0b. Post-ticket cancel (Flow 5, 2026-09-17). The object word is required
    //     ("ยกเลิกเคส"), so a bare "ยกเลิก" keeps its other meanings below.
    let cancel = detectCancelIntent(text, pending?.kind === "cancel");
    // "ไม่ยกเลิก" answers the cancel question even after another bot message (H5).
    if (asked?.kind === "cancel" && isExplicitDeclineCancel(text)) {
      cancel = { kind: "DECLINE_CANCEL", ticketNumber: numberInText };
    }
    // The "which case to cancel" list answered with just a number.
    if (cancel.kind === "NONE" && pending?.kind === "cancel_which_case" && isBareNumber) {
      cancel = { kind: "CANCEL_REQUEST", ticketNumber: numberInText };
    }
    if (cancel.kind === "CONFIRM_CANCEL") {
      let target = byNumber(cancel.ticketNumber);
      if (!target && !cancel.ticketNumber) {
        target = byNumber(pending?.kind === "cancel" ? pending.ticketNumber : null);
        // The explicit phrase without a number: the only open case qualifies;
        // a bare yes never does (same lesson as the close protocol).
        if (!target && /ยกเลิก|cancel/i.test(text) && tickets.length === 1) target = tickets[0];
      }
      if (!target && cancel.ticketNumber) {
        const old = await this.loadClosedByNumber(input.conversationId, cancel.ticketNumber);
        if (old) {
          await this.notify(input, old, "cancel_case_not_open", this.eventKey(input, "cancel_not_open"), { quickReplies: [] });
          return { handled: true, ticketId: old.id, reason: "CANCEL_CASE_NOT_OPEN" };
        }
      }
      if (!target) {
        if (tickets.length === 0) {
          await this.notify(input, null, "cancel_no_open_case", this.eventKey(input, "cancel_no_open_case"));
          return { handled: true, reason: "NO_OPEN_CASE" };
        }
        return this.askWhichCaseToCancel(input, tickets);
      }
      // A delivered case is not cancellable (state machine): the customer is
      // really saying "we are done" — offer the close question instead.
      if (target.status === "RESOLVED" || target.status === "CUSTOMER_CONFIRMED") return this.askClose(input, target);
      // H8: the confirmation chip answers a cancel question about this case;
      // typed on a case nobody asked about, the question comes first.
      if (!(await this.wasAsked(input.conversationId, target, "cancel"))) return this.askCancel(input, target);
      return this.cancelTicket(input, target);
    }
    if (cancel.kind === "DECLINE_CANCEL" && asked?.kind === "cancel") {
      const target = byNumber(numberInText ?? asked.ticketNumber);
      await this.notify(input, target, "cancel_declined", this.eventKey(input, "cancel_declined"), { quickReplies: [] });
      return { handled: true, ticketId: target?.id, from: target?.status, to: target?.status, reason: "CANCEL_DECLINED" };
    }
    if (cancel.kind === "CANCEL_REQUEST") {
      // Mid-intake "ยกเลิกเคส" with no number is the draft, not a filed case:
      // the AI gate's CANCEL_RESET owns that turn.
      if (!cancel.ticketNumber && pending?.kind === "create") return { handled: false, reason: "CANCEL_DRAFT_TO_AI" };
      if (tickets.length === 0 && !cancel.ticketNumber) {
        await this.notify(input, null, "cancel_no_open_case", this.eventKey(input, "cancel_no_open_case"));
        return { handled: true, reason: "NO_OPEN_CASE" };
      }
      let target = byNumber(cancel.ticketNumber) ?? (!cancel.ticketNumber && tickets.length === 1 ? tickets[0] : null);
      if (!target && !cancel.ticketNumber && activeTicket) {
        const matchBySubject = tickets.find((t) => {
          const sub = String(t.subject || "").trim().toLowerCase();
          return sub && text.toLowerCase().includes(sub);
        });
        target = matchBySubject ?? activeTicket;
      }
      if (!target && cancel.ticketNumber) {
        const old = await this.loadClosedByNumber(input.conversationId, cancel.ticketNumber);
        if (old) {
          await this.notify(input, old, "cancel_case_not_open", this.eventKey(input, "cancel_not_open"), { quickReplies: [] });
          return { handled: true, ticketId: old.id, reason: "CANCEL_CASE_NOT_OPEN" };
        }
        return { handled: false, reason: "CANCEL_TARGET_NOT_FOUND" };
      }
      if (!target) return this.askWhichCaseToCancel(input, tickets);
      if (target.status === "RESOLVED" || target.status === "CUSTOMER_CONFIRMED") return this.askClose(input, target);
      return this.askCancel(input, target, cancel.reason ?? null);
    }

    // 1. "ยืนยันปิดเคส [TCK]" — the only thing that closes.
    if (close.kind === "CONFIRM_CLOSE") {
      let target = byNumber(close.ticketNumber);
      if (!target && !close.ticketNumber) {
        // Without a number, only the case the question was about qualifies:
        // the number in the question, or the single case waiting on it.
        // Never "the only open case" — that fallback closed TCK-2026-82178
        // (still TRIAGED, never asked) on a "ยืนยัน" meant for a new report.
        target = byNumber(pending?.kind === "close" ? pending.ticketNumber : null);
        if (!target) {
          const confirmed = tickets.filter((t) => t.status === "CUSTOMER_CONFIRMED");
          if (confirmed.length === 1) target = confirmed[0];
        }
      }
      if (!target && close.ticketNumber) {
        const old = await this.loadClosedByNumber(input.conversationId, close.ticketNumber);
        if (old) return this.answerEndedCase(input, old, "close");
      }
      if (!target) {
        if (tickets.length === 0) {
          await this.notify(input, null, "close_no_open_case", this.eventKey(input, "no_open_case"));
          return { handled: true, reason: "NO_OPEN_CASE" };
        }
        return this.askWhichCase(input, tickets);
      }
      // H8: closes only a case that was asked the close question (by us or by
      // the AI flow) since its last status change; otherwise ask first.
      if (!(await this.wasAsked(input.conversationId, target, "close"))) return this.askClose(input, target);
      return this.closeTicket(input, target);
    }

    // 2. "ยังไม่ปิด" while the close question is out — keep it open, say so.
    if (close.kind === "DECLINE_CLOSE" && asked?.kind === "close") {
      let target = byNumber(numberInText ?? asked.ticketNumber);
      if (!target) {
        const confirmed = tickets.filter((t) => t.status === "CUSTOMER_CONFIRMED");
        target = confirmed.length === 1 ? confirmed[0] : tickets.length === 1 ? tickets[0] : null;
      }
      if (target && target.status === "CUSTOMER_CONFIRMED") {
        const r = await ticketStateMachine.transition({
          ticketRef: target.id,
          to: "RESOLVED",
          actor: "customer",
          actorRef: `conversation:${input.conversationId}`,
          reason: "Customer declined to close for now",
          correlationId: input.correlationId,
          source: "customer_reply",
        });
        if (!r.applied) logger.warn({ ticketId: target.id, code: r.code }, "Could not return ticket to RESOLVED");
      }
      await this.notify(input, target, "close_declined", this.eventKey(input, "close_declined"), { quickReplies: [] });
      return { handled: true, ticketId: target?.id, from: target?.status, to: target?.status === "CUSTOMER_CONFIRMED" ? "RESOLVED" : target?.status, reason: "CLOSE_DECLINED" };
    }

    // 3. "ปิดเคส [TCK]" — menu chip, typed, or a bare number answering the list.
    if (close.kind === "CLOSE_REQUEST") {
      // 3a. Explicit ticket reference (e.g. "ปิดเคส TCK-2026-101", "ขอปิดเคส TCK-201")
      if (close.ticketNumber) {
        const target = byNumber(close.ticketNumber);
        if (target) {
          return this.askClose(input, target);
        }
        const old = await this.loadClosedByNumber(input.conversationId, close.ticketNumber);
        if (old) return this.answerEndedCase(input, old, "close");
        if (tickets.length === 0) {
          await this.notify(input, null, "close_no_open_case", this.eventKey(input, "no_open_case"));
          return { handled: true, reason: "NO_OPEN_CASE" };
        }
        return this.askWhichCase(input, tickets);
      }

      // 3b. No open cases exist
      if (tickets.length === 0) {
        await this.notify(input, null, "close_no_open_case", this.eventKey(input, "no_open_case"));
        logger.info({ conversationId: input.conversationId, correlationId: input.correlationId }, "Close requested with no open case; answered at the edge");
        return { handled: true, reason: "NO_OPEN_CASE" };
      }

      // 3c. Explicit demonstrative reference to this case (e.g. "ขอปิดเคสนี้ค่ะ", "ปิดตั๋วนี้")
      if (close.isThisCaseRef) {
        if (activeTicket) {
          return this.askClose(input, activeTicket);
        }
        // No active ticket set or active ticket was closed/stale: must not guess!
        return this.askWhichCase(input, tickets);
      }

      // 3d. Generic close request (e.g. "ขอปิดเคสค่ะ")
      // If exactly one open ticket exists, offer that one.
      // If multiple open tickets exist, MUST ASK clarification rather than guessing or picking active!
      if (tickets.length === 1) {
        return this.askClose(input, tickets[0]);
      }
      return this.askWhichCase(input, tickets);
    }

    const scopePending = pending?.kind === "scope";
    const scope = detectReopenScope(text, scopePending);
    const intent = detectConfirmationIntent(text);

    // 4. Feedback right after a re-open: goes to the engineer, not to the AI.
    const windowMin = config.REOPEN_FEEDBACK_WINDOW_MINUTES;
    if (windowMin > 0 && scope !== "NEW" && intent !== "CONFIRMED") {
      const fresh = tickets.find(
        (t) => t.status === "REOPENED" && t.last_reopened_at && Date.now() - new Date(t.last_reopened_at).getTime() <= windowMin * 60_000
      );
      const trimmed = text.trim();
      const trivial = trimmed.length < 8 || /^(?:ขอบคุณ|โอเค|ok|okay|รับทราบ|ครับ|ค่ะ|คับ|จ้า|👍|✅)/i.test(trimmed);
      // A message that names ANOTHER case is that case's business, never
      // feedback for the one just re-opened (live 2026-09-08: the chip
      // "ยังมีปัญหาอยู่ TCK-2026-62090" was filed three times as feedback on
      // TCK-2026-49825, and a screenshot went to the wrong work item).
      const aboutAnotherCase = Boolean(numberInText && fresh && numberInText !== String(fresh.ticket_number || "").toUpperCase());
      // The window collects the first couple of descriptions only. Capturing
      // every line for 30 minutes turned the bot into "รับไว้แล้วค่ะ" for
      // anything the customer said (live 2026-09-08, conversation 1203).
      let windowExhausted = false;
      if (fresh && fresh.last_reopened_at) {
        const cnt = await pool.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM ticket_events
            WHERE ticket_id = $1 AND event_type = 'CUSTOMER_FEEDBACK' AND created_at >= $2::timestamptz`,
          [fresh.id, new Date(fresh.last_reopened_at).toISOString()]
        ).catch(() => ({ rows: [{ n: "0" }] }));
        windowExhausted = Number(cnt.rows[0]?.n || 0) >= 2;
      }
      // The chip for the fresh case itself carries no symptom: acknowledge, don't file it.
      const justTheChip = Boolean(fresh && numberInText && this.feedbackFrom(trimmed) === null);
      if (fresh && !trivial && !aboutAnotherCase && justTheChip) {
        await this.notify(input, fresh, "acknowledgement_action", this.eventKey(input, "feedback_ack"), { quickReplies: [] });
        return { handled: true, ticketId: fresh.id, reason: "REOPEN_ALREADY_OPEN" };
      }
      if (fresh && !trivial && !aboutAnotherCase && !windowExhausted) {
        // A screenshot may be waiting for a case ("ได้รับรูปแล้ว รบกวนอธิบาย…"):
        // this feedback is that description, so the image goes to the same
        // case too. Seen live 2026-09-08: "เป็นรูปของเคส TCK-… ครับ" was saved
        // as feedback while the picture stayed unattached.
        let attachedImages = 0;
        try {
          const pendingImage = await pool.query(
            `SELECT 1 FROM message_attachments ma JOIN messages m ON m.id = ma.message_id
              WHERE m.conversation_id = $1::integer
                AND ma.metadata->>'awaitingCaseConfirm' = 'true'
                AND COALESCE(ma.metadata->>'planeIssueId', '') = ''
                AND ma.created_at >= NOW() - INTERVAL '30 minutes'
              LIMIT 1`,
            [input.conversationId]
          );
          if (pendingImage.rows.length > 0 && fresh.ticket_number) {
            const { PlaneService } = await import("./planeService");
            const { AdapterFactory } = await import("../adapters/AdapterFactory");
            const planeService = new PlaneService(AdapterFactory.getAdapter());
            const r = await planeService.attachPendingImagesToTicketNumber(input.conversationId, fresh.ticket_number);
            attachedImages = r.attached;
            await pool.query(
              `UPDATE message_attachments ma SET metadata = COALESCE(ma.metadata, '{}'::jsonb) || '{"awaitingCaseConfirm": false}'::jsonb
                 FROM messages m WHERE m.id = ma.message_id AND m.conversation_id = $1::integer AND ma.metadata->>'awaitingCaseConfirm' = 'true'`,
              [input.conversationId]
            ).catch(() => {});
          }
        } catch (imgErr: any) {
          logger.warn({ ticketId: fresh.id, error: imgErr?.message }, "Could not attach the pending screenshot to the re-opened case");
        }
        // "เป็นรูปของเคส …" is not a symptom; save only real descriptions.
        const isJustImageLabel = /^\s*(?:เป็น)?รูป(?:ของ|เคส|นี้)/.test(trimmed) && trimmed.replace(TICKET_NUMBER_PATTERN, "").length < 40;
        if (!isJustImageLabel) await this.saveFeedback(input, fresh, trimmed, fresh.reopened_count ?? null);
        await this.notify(input, fresh, attachedImages > 0 ? "image_attached" : "reopen_feedback_saved", this.eventKey(input, "feedback"), { quickReplies: [] });
        return { handled: true, ticketId: fresh.id, reason: attachedImages > 0 ? "REOPEN_IMAGE_ATTACHED" : "REOPEN_FEEDBACK_SAVED" };
      }
    }

    // 5. Answer to the delivery message ("does it work now?") — or a "still
    //    broken" about a case closed within the re-open window.
    const awaiting = tickets.filter((t) => t.status === "RESOLVED" || t.status === "CUSTOMER_CONFIRMED");

    // "ปัญหาเดิมหรือปัญหาใหม่" answered with a bare "ใช่" / "โอเค": it picks
    // neither, so the question is asked again rather than guessed (H3).
    if (scopePending && scope === "NONE" && intent === "NONE" && isBareShortAnswer(text) && pending?.ticketNumber) {
      const scoped = byNumber(pending.ticketNumber, awaiting) ?? byNumber(pending.ticketNumber, await this.loadRecentlyClosed(input.conversationId));
      if (scoped) return this.askScope(input, scoped, "which_kind_again");
    }

    // The case the answer is about: the number in the text, else the case the
    // pending "same or new?" question named. A named case is answered for that
    // case only — it never falls back to another waiting case (H1: "ปัญหาใหม่
    // <closed TCK>" closed an unrelated delivered case).
    const named = numberInText || (scopePending ? pending?.ticketNumber ?? null : null);
    let target: OpenTicket | null = null;
    if (named) {
      target = byNumber(named, awaiting);
      if (!target) {
        const openNamed = byNumber(named);
        if (openNamed) return this.answerCaseInProgress(input, openNamed, text, scope, intent);
        const recent = await this.loadRecentlyClosed(input.conversationId);
        const closedNamed = byNumber(named, recent);
        if (closedNamed) {
          if (scope === "NEW") return this.promptNewIssue(input, closedNamed);
          if (!(scope === "SAME" || scope === "AMBIGUOUS" || intent === "REJECTED")) {
            if (intent === "CONFIRMED") return this.answerEndedCase(input, closedNamed, "close");
            return { handled: false, reason: "CLOSED_CASE_NO_PROTOCOL_INTENT" };
          }
          target = closedNamed;
        } else {
          const old = await this.loadClosedByNumber(input.conversationId, named);
          if (old) {
            if (scope === "NEW") return this.promptNewIssue(input, old);
            if (scope === "SAME" || scope === "AMBIGUOUS" || intent === "REJECTED") return this.answerEndedCase(input, old, "reopen");
            if (intent === "CONFIRMED") return this.answerEndedCase(input, old, "close");
          }
          return { handled: false, reason: "NAMED_CASE_NOT_FOUND" };
        }
      }
    }
    if (!target) {
      if (awaiting.length === 0) return { handled: false, reason: "NO_TICKET_AWAITING_CONFIRMATION" };
      if (awaiting.length === 1) {
        target = awaiting[0];
      } else {
        if (scope === "NONE" && intent === "NONE") return { handled: false, reason: "NO_CONFIRMATION_INTENT" };
        // "มีอีกปัญหา …" typed as a full report stays with the AI (force_new).
        if (scope === "NEW" && !/^\s*(?:เป็น)?(?:ปัญหา|เรื่อง)ใหม่/.test(text)) return { handled: false, reason: "NEW_ISSUE_TO_AI" };
        return this.askWhichAwaiting(input, awaiting, scope, intent);
      }
    }

    // While the "ปัญหาเดิมหรือปัญหาใหม่" question is pending, resolve natural phrasing.
    let effectiveScope = scope;
    if (scopePending) {
      if (effectiveScope === "NONE" || effectiveScope === "AMBIGUOUS") {
        const hasNew = NEW_ISSUE_PATTERN.test(text) || /(?:^|\s)(?:เป็น)?(?:ปัญหา|เรื่อง|เคส)?\s*ใหม่/i.test(text);
        const hasSame =
          SAME_ISSUE_PATTERN.test(text) ||
          /(?:^|\s)(?:เป็น)?(?:ปัญหา|เรื่อง|อาการ|อัน|เคส)?\s*เดิม/i.test(text) ||
          intent === "REJECTED";
        if (hasNew && !hasSame) {
          effectiveScope = "NEW";
        } else if (hasSame && !hasNew) {
          effectiveScope = "SAME";
        } else if (!hasNew && intent !== "CONFIRMED" && SYMPTOM_PATTERN.test(text)) {
          // Customer answered the scope question by describing the failure/symptoms
          // (e.g. "ตรวจสอบที่ Production แล้ว ระดับการศึกษา ปวส. ยังไม่ขึ้นให้เลือกเลยค่ะ").
          // Only a described symptom counts (AD-08); "ขอคุยกับเจ้าหน้าที่" or
          // "ใช้งานได้แล้ว" typed here used to re-open the case too (H2).
          effectiveScope = "SAME";
        }
      }
    }

    if (effectiveScope === "NEW") {
      const answeredChip = scopePending || /^\s*(?:เป็น)?(?:ปัญหา|เรื่อง)ใหม่/.test(text);
      if (answeredChip) {
        // "ปัญหาใหม่": the delivered case is done as far as the customer is
        // concerned — close it (Plane → Close) and start intake over; the
        // customer's next message is a fresh report for the AI (the gate's
        // new-issue net sees this turn, so it is never folded into the old case).
        // A case already closed has nothing to close: just ask for the report.
        if (target.status === "CLOSED") return this.promptNewIssue(input, target);
        return this.closeTicket(input, target, "reopen_new_issue_prompt");
      }
      // "มีอีกปัญหา …" typed as a full report: leave it to the AI (force_new);
      // the delivered case keeps waiting for its own answer.
      return { handled: false, reason: "NEW_ISSUE_TO_AI" };
    }
    if (effectiveScope === "SAME") {
      return this.reopenTicket(input, target, this.feedbackFrom(text));
    }
    if (effectiveScope === "AMBIGUOUS" || (intent === "REJECTED" && !scopePending)) {
      // Same problem or a new one? Two chips decide (operator decision
      // 2026-09-08: always ask; the chip "ยังมีปัญหาอยู่" lands here).
      // Only ask on the initial report, never repeatedly if already pending.
      return this.askScope(input, target);
    }
    if (intent === "CONFIRMED") {
      // Positive, but nothing closes yet: ask the close question.
      if (target.status === "CLOSED") return this.answerEndedCase(input, target, "close");
      return this.askClose(input, target);
    }
    return { handled: false, reason: "NO_CONFIRMATION_INTENT" };
  }
}

export const customerConfirmationHandler = new CustomerConfirmationHandler();
