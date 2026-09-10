import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";
import {
  detectConfirmationIntent,
  detectCloseIntent,
  detectReopenScope,
  detectReopenConfirmation,
  TICKET_NUMBER_PATTERN,
} from "../domain/ticket/CustomerConfirmation";
import { ticketStateMachine } from "../domain/ticket/TicketStateMachine";
import type { TicketLifecycleStatus } from "../domain/ticket/TicketLifecycle";
import { customerNotificationService, type CustomerNotificationType } from "./CustomerNotificationService";
import { doneEmailService, reopenAlertService } from "./UrgentAlertService";

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

type PendingKind = "close" | "which_case" | "reopen" | "scope";

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
   * Whether the bot's LAST word to this customer was one of the protocol's
   * questions, and which. Only the last message counts (seen live 2026-09-08:
   * a stale close question made a "ยืนยัน" meant for a create confirmation
   * close the wrong case). The explicit chip texts keep working regardless.
   */
  private async pendingQuestion(conversationId: number): Promise<{ kind: PendingKind; ticketNumber: string | null } | null> {
    const last = await pool.query<{ content: string }>(
      `SELECT content FROM messages
        WHERE conversation_id = $1 AND role = 'ai'
          AND created_at >= NOW() - ($2::int * INTERVAL '1 minute')
        ORDER BY id DESC LIMIT 1`,
      [conversationId, CLOSE_QUESTION_WINDOW_MINUTES]
    );
    const content = String(last.rows[0]?.content || "");
    if (!content) return null;
    const m = content.match(TICKET_NUMBER_PATTERN);
    const num = m ? m[0].toUpperCase() : null;
    if (/แตะเลือกข้างล่างนี้|แตะเลือกได้เลย/.test(content)) return { kind: "which_case", ticketNumber: null };
    if (/(?:ปัญหาเดิม|อาการเดิม)[^\n]{0,80}ปัญหาใหม่/.test(content)) return { kind: "scope", ticketNumber: num };
    if (/ยืนยันเปิดเคสอีกครั้ง|เปิดเคส[^\n]{0,80}อีกครั้งใช่ไหม/.test(content)) return { kind: "reopen", ticketNumber: num };
    if (/ต้องการปิดเคส|ยืนยันปิดเคส|ปิดเคส[^\n]{0,80}ใช่ไหม/.test(content)) return { kind: "close", ticketNumber: num };
    return null;
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

  /** Walks the ticket to CLOSED along ROUTE_TO_CLOSED and tells the customer. */
  private async closeTicket(
    input: { conversationId: number; correlationId?: string },
    ticket: OpenTicket,
    notifyAs: "closed" | "reopen_new_issue_prompt" = "closed"
  ): Promise<ConfirmationOutcome> {
    const route = ROUTE_TO_CLOSED[ticket.status];
    if (!route) {
      logger.warn({ ticketId: ticket.id, status: ticket.status }, "No close route for ticket status");
      return { handled: false, reason: "NO_CLOSE_ROUTE" };
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
        return { handled: false, ticketId: ticket.id, from: ticket.status, to: current, reason: r.code };
      }
      current = next;
      if (next === "CLOSED") closedEventId = r.eventId ?? null;
    }

    await this.notify(input, ticket, notifyAs, closedEventId ? `ticket_event:${closedEventId}` : `ticket:${ticket.id}:closed`, { quickReplies: [] });
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
      return { handled: false, reason: reopened.code };
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

  /** The text minus the chip words / case number: what the customer actually said. */
  private feedbackFrom(text: string): string | null {
    const stripped = String(text || "")
      .replace(TICKET_NUMBER_PATTERN, "")
      .replace(/ยังมีปัญหาอยู่|อาการเดิมยังไม่หาย|(?:เป็น)?(?:ปัญหา|เรื่อง|อัน)เดิม|อาการเดิม|ยังมีปัญหา|ยังไม่หาย|ครับ|ค่ะ|คับ|นะคะ|นะครับ/g, "")
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
    const pending = await this.pendingQuestion(input.conversationId);
    const close = detectCloseIntent(text, pending?.kind === "close" || pending?.kind === "which_case");
    const numberInText = (text.match(TICKET_NUMBER_PATTERN)?.[0] || "").toUpperCase() || null;
    const byNumber = (n: string | null | undefined, pool_: OpenTicket[] = tickets) =>
      n ? pool_.find((t) => String(t.ticket_number || "").toUpperCase() === n.toUpperCase()) ?? null : null;

    // 0. "ยืนยันเปิดเคสอีกครั้ง [TCK]" — the explicit re-open chip (AI path or
    //    the re-open question). A bare yes counts only right after that question.
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
        if (old) {
          await this.notify(input, old, "reopen_too_old", this.eventKey(input, "reopen_too_old"), { detail: String(config.REOPEN_AFTER_CLOSE_DAYS), quickReplies: [] });
          return { handled: true, ticketId: old.id, reason: "REOPEN_TOO_OLD" };
        }
      }
      if (!target) return { handled: false, reason: "REOPEN_TARGET_NOT_FOUND" };
      if (!["RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"].includes(target.status)) {
        await this.notify(input, target, "acknowledgement_action", this.eventKey(input, "reopen_noop"), { quickReplies: [] });
        return { handled: true, ticketId: target.id, reason: "ALREADY_OPEN" };
      }
      return this.reopenTicket(input, target, null);
    }
    if (pending?.kind === "reopen" && /^\s*(?:ยกเลิก|ไม่|cancel|no)\b/i.test(text)) {
      await this.notify(input, null, "acknowledgement_action", this.eventKey(input, "reopen_cancel"), { quickReplies: [] });
      return { handled: true, reason: "REOPEN_CANCELLED" };
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
      if (!target) {
        if (tickets.length === 0) {
          await this.notify(input, null, "close_no_open_case", this.eventKey(input, "no_open_case"));
          return { handled: true, reason: "NO_OPEN_CASE" };
        }
        return this.askWhichCase(input, tickets);
      }
      return this.closeTicket(input, target);
    }

    // 2. "ยังไม่ปิด" while the close question is pending — keep it open, say so.
    if (close.kind === "DECLINE_CLOSE" && pending?.kind === "close") {
      let target = byNumber(pending.ticketNumber);
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
      if (tickets.length === 0) {
        await this.notify(input, null, "close_no_open_case", this.eventKey(input, "no_open_case"));
        logger.info({ conversationId: input.conversationId, correlationId: input.correlationId }, "Close requested with no open case; answered at the edge");
        return { handled: true, reason: "NO_OPEN_CASE" };
      }
      const target = byNumber(close.ticketNumber) ?? (!close.ticketNumber && tickets.length === 1 ? tickets[0] : null);
      if (!target) return this.askWhichCase(input, tickets);
      return this.askClose(input, target);
    }

    const scope = detectReopenScope(text);
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
          const pending = await pool.query(
            `SELECT 1 FROM message_attachments ma JOIN messages m ON m.id = ma.message_id
              WHERE m.conversation_id = $1::integer
                AND ma.metadata->>'awaitingCaseConfirm' = 'true'
                AND COALESCE(ma.metadata->>'planeIssueId', '') = ''
                AND ma.created_at >= NOW() - INTERVAL '30 minutes'
              LIMIT 1`,
            [input.conversationId]
          );
          if (pending.rows.length > 0 && fresh.ticket_number) {
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
    let target: OpenTicket | null = numberInText ? awaiting.find((t) => String(t.ticket_number || "").toUpperCase() === numberInText) ?? null : null;
    if (!target && numberInText && (scope === "SAME" || intent === "REJECTED")) {
      const recent = await this.loadRecentlyClosed(input.conversationId);
      target = byNumber(numberInText, recent);
      if (!target) {
        const old = await this.loadClosedByNumber(input.conversationId, numberInText);
        if (old) {
          await this.notify(input, old, "reopen_too_old", this.eventKey(input, "reopen_too_old"), { detail: String(config.REOPEN_AFTER_CLOSE_DAYS), quickReplies: [] });
          return { handled: true, ticketId: old.id, reason: "REOPEN_TOO_OLD" };
        }
      }
    }
    if (!target) {
      if (awaiting.length === 0) return { handled: false, reason: "NO_TICKET_AWAITING_CONFIRMATION" };
      target = awaiting[0];
    }

    // While the "ปัญหาเดิมหรือปัญหาใหม่" question is pending, a one-word answer counts.
    let effectiveScope = scope;
    if (pending?.kind === "scope" && scope === "NONE") {
      if (/^\s*(?:เป็น)?(?:ปัญหา|เรื่อง|อาการ|อัน)?\s*เดิม/.test(text)) effectiveScope = "SAME";
      else if (/^\s*(?:เป็น)?(?:ปัญหา|เรื่อง)?\s*ใหม่/.test(text)) effectiveScope = "NEW";
    }

    if (effectiveScope === "NEW") {
      const answeredChip = pending?.kind === "scope" || /^\s*(?:เป็น)?(?:ปัญหา|เรื่อง)ใหม่/.test(text);
      if (answeredChip) {
        // "ปัญหาใหม่": the delivered case is done as far as the customer is
        // concerned — close it (Plane → Close) and start intake over; the
        // customer's next message is a fresh report for the AI (the gate's
        // new-issue net sees this turn, so it is never folded into the old case).
        return this.closeTicket(input, target, "reopen_new_issue_prompt");
      }
      // "มีอีกปัญหา …" typed as a full report: leave it to the AI (force_new);
      // the delivered case keeps waiting for its own answer.
      return { handled: false, reason: "NEW_ISSUE_TO_AI" };
    }
    if (effectiveScope === "SAME") {
      return this.reopenTicket(input, target, this.feedbackFrom(text));
    }
    if (effectiveScope === "AMBIGUOUS" || intent === "REJECTED") {
      // Same problem or a new one? Two chips decide (operator decision
      // 2026-09-08: always ask; the chip "ยังมีปัญหาอยู่" lands here).
      await this.notify(input, target, "reopen_which_kind", this.eventKey(input, "which_kind"));
      return { handled: true, ticketId: target.id, reason: "REOPEN_SCOPE_ASKED" };
    }
    if (intent === "CONFIRMED") {
      // Positive, but nothing closes yet: ask the close question.
      return this.askClose(input, target);
    }
    return { handled: false, reason: "NO_CONFIRMATION_INTENT" };
  }
}

export const customerConfirmationHandler = new CustomerConfirmationHandler();
