import { pool } from "../adapters/postgres/PostgresAdapter";
import { createLogger } from "../observability/logger";
import { detectConfirmationIntent } from "../domain/ticket/CustomerConfirmation";
import { ticketStateMachine } from "../domain/ticket/TicketStateMachine";
import { customerNotificationService } from "./CustomerNotificationService";

const logger = createLogger("customer-confirmation");

export interface ConfirmationOutcome {
  handled: boolean;
  ticketId?: number;
  from?: string;
  to?: string;
  reason?: string;
}

/**
 * Closes the loop on the Golden Flow: turns a customer's reply into the
 * CUSTOMER_CONFIRMED or REOPENED transition.
 *
 * Only engages when the conversation has a ticket in RESOLVED — i.e. the
 * customer was actually asked to confirm something. Any other message is left
 * alone and flows to the AI as normal, so this cannot hijack ordinary
 * conversation.
 */
export class CustomerConfirmationHandler {
  /** The RESOLVED ticket this conversation is waiting on, if any. */
  private async findAwaitingTicket(conversationId: number): Promise<{
    id: number;
    ticket_number: string | null;
    project_id: number | null;
    org_id: string | null;
  } | null> {
    const { rows } = await pool.query(
      `SELECT id, ticket_number, project_id, org_id
         FROM tickets
        WHERE conversation_id = $1 AND status = 'RESOLVED'
        ORDER BY lifecycle_changed_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [conversationId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Returns handled=false when the message is not an answer to a pending
   * confirmation, which is the common case — the caller then continues with
   * normal processing.
   */
  async handle(input: {
    conversationId: number;
    text: string;
    correlationId?: string;
  }): Promise<ConfirmationOutcome> {
    const ticket = await this.findAwaitingTicket(input.conversationId);
    if (!ticket) {
      return { handled: false, reason: "NO_TICKET_AWAITING_CONFIRMATION" };
    }

    const intent = detectConfirmationIntent(input.text);
    if (intent === "NONE") {
      // The customer said something else while a ticket is resolved. Leave it
      // to the AI; do not guess at a state change.
      return { handled: false, reason: "NO_CONFIRMATION_INTENT" };
    }

    if (intent === "CONFIRMED") {
      const confirmed = await ticketStateMachine.transition({
        ticketRef: ticket.id,
        to: "CUSTOMER_CONFIRMED",
        actor: "customer",
        actorRef: `conversation:${input.conversationId}`,
        reason: "Customer confirmed the resolution",
        correlationId: input.correlationId,
        source: "customer_reply",
      });

      if (!confirmed.applied) {
        logger.warn({ ticketId: ticket.id, code: confirmed.code }, "Customer confirmation could not be applied");
        return { handled: false, reason: confirmed.code };
      }

      // CUSTOMER_CONFIRMED -> CLOSED is the system's own bookkeeping step; the
      // customer has already done everything asked of them.
      const closed = await ticketStateMachine.transition({
        ticketRef: ticket.id,
        to: "CLOSED",
        actor: "system",
        actorRef: "confirmation-handler",
        reason: "Closed after customer confirmation",
        correlationId: input.correlationId,
        source: "customer_reply",
      });

      if (closed.applied) {
        await customerNotificationService.send({
          conversationId: input.conversationId,
          notificationType: "closed",
          idempotencyKey: closed.eventId ? `ticket_event:${closed.eventId}` : `ticket:${ticket.id}:closed`,
          ticketId: ticket.id,
          ticketNumber: ticket.ticket_number,
          projectId: ticket.project_id,
          orgId: ticket.org_id,
          correlationId: input.correlationId,
        });
      }

      logger.info(
        { ticketId: ticket.id, conversationId: input.conversationId, correlationId: input.correlationId },
        "Customer confirmed resolution; ticket closed"
      );
      return { handled: true, ticketId: ticket.id, from: "RESOLVED", to: closed.applied ? "CLOSED" : "CUSTOMER_CONFIRMED" };
    }

    // REJECTED — the fix did not work.
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

    // Straight back into engineering hands. REOPENED -> IN_PROGRESS is the
    // transition that puts it back on the board, and it does change the Plane
    // state (Done -> Open), so it is pushed.
    const working = await ticketStateMachine.transition({
      ticketRef: ticket.id,
      to: "IN_PROGRESS",
      actor: "system",
      actorRef: "confirmation-handler",
      reason: "Reopened by customer; returned to engineering",
      correlationId: input.correlationId,
      source: "customer_reply",
    });

    await customerNotificationService.send({
      conversationId: input.conversationId,
      notificationType: "reopened",
      idempotencyKey: reopened.eventId ? `ticket_event:${reopened.eventId}` : `ticket:${ticket.id}:reopened`,
      ticketId: ticket.id,
      ticketNumber: ticket.ticket_number,
      projectId: ticket.project_id,
      orgId: ticket.org_id,
      correlationId: input.correlationId,
    });

    logger.info(
      { ticketId: ticket.id, conversationId: input.conversationId, correlationId: input.correlationId },
      "Customer rejected resolution; ticket reopened"
    );
    return { handled: true, ticketId: ticket.id, from: "RESOLVED", to: working.applied ? "IN_PROGRESS" : "REOPENED" };
  }
}

export const customerConfirmationHandler = new CustomerConfirmationHandler();
