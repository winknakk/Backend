import { pool } from "../adapters/postgres/PostgresAdapter";
import { createLogger } from "../observability/logger";

const logger = createLogger("conversation-focus");

/**
 * Single owner of `conversations.active_ticket_id` for the deterministic
 * paths (LINE confirmation handler, LINE case context, portal).
 *
 * The column is conversational focus only — "which case are we talking
 * about" — never authorisation (CaseResolver hard invariant), and this
 * service never touches `conversations.project_id`.
 *
 * Spec v2 (2026-09-17): the Ticket Operations Hub sets the focus when it
 * creates a case; the close and cancel protocols release it when the case
 * reaches a terminal status.
 */
export class ConversationFocusService {
  /** Points the conversation at a case. Idempotent. */
  async setActiveTicket(conversationId: number, ticketId: number): Promise<void> {
    await pool
      .query(`UPDATE conversations SET active_ticket_id = $1::integer, updated_at = NOW() WHERE id = $2::integer`, [ticketId, conversationId])
      .catch((err) => logger.warn({ conversationId, ticketId, error: err.message }, "Could not set active ticket"));
  }

  /**
   * A case reached CLOSED / CANCELLED: it must not stay the focus of any
   * conversation. When the case's own conversation has exactly one other
   * open case, that one becomes the focus (the customer is obviously still
   * talking about it); with several, the focus is left empty so the case
   * resolver asks rather than guesses.
   */
  async releaseTerminalTicket(ticketId: number): Promise<{ cleared: number; refocusedTo: number | null }> {
    let cleared = 0;
    let refocusedTo: number | null = null;
    try {
      const res = await pool.query<{ id: number }>(
        `UPDATE conversations SET active_ticket_id = NULL, updated_at = NOW()
          WHERE active_ticket_id = $1::integer
          RETURNING id`,
        [ticketId]
      );
      cleared = res.rowCount || 0;
      for (const row of res.rows) {
        const open = await pool.query<{ id: number }>(
          `SELECT id FROM tickets
            WHERE conversation_id = $1::integer AND deleted_at IS NULL
              AND UPPER(COALESCE(status, '')) NOT IN ('CLOSED', 'CANCELLED')
            ORDER BY lifecycle_changed_at DESC NULLS LAST, id DESC
            LIMIT 2`,
          [row.id]
        );
        if (open.rows.length === 1) {
          refocusedTo = Number(open.rows[0].id);
          await this.setActiveTicket(Number(row.id), refocusedTo);
        }
      }
    } catch (err: any) {
      logger.warn({ ticketId, error: err.message }, "Could not release active ticket");
    }
    return { cleared, refocusedTo };
  }
}

export const conversationFocusService = new ConversationFocusService();
