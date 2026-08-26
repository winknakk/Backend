import { pool } from "../../adapters/postgres/PostgresAdapter";
import { IOutboxRepository, OutboxEventPersistence } from "../../domain/repositories/IOutboxRepository";

/**
 * PostgreSQL implementation of the Outbox Repository.
 */
export class PostgresOutboxRepository implements IOutboxRepository {
  /**
   * Fetches pending outbox events using a safe, non-blocking SELECT query.
   */
  async fetchPending(limit: number): Promise<OutboxEventPersistence[]> {
    // Only events that are actually due. A transient failure sets
    // next_attempt_at, so a failing dependency is retried with backoff
    // instead of being hammered on every polling cycle.
    const { rows } = await pool.query(
      `SELECT id, event_type, payload, status, attempts, error_message, created_at, updated_at
       FROM outbox_events
       WHERE status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
       ORDER BY id ASC
       LIMIT $1`,
      [limit]
    );
    return rows.map((r: any) => ({
      id: r.id,
      event_type: r.event_type,
      payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
      status: r.status,
      attempts: r.attempts,
      error_message: r.error_message || undefined,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  /**
   * Marks the event as successfully processed.
   */
  async markProcessed(id: number): Promise<void> {
    await pool.query(
      `UPDATE outbox_events 
       SET status = 'processed', updated_at = NOW() 
       WHERE id = $1`,
      [id]
    );
  }

  /**
   * Increments attempt count and updates status/error logs for failures.
   */
  async updateAttempts(id: number, attempts: number, errorMessage: string, status: string): Promise<void> {
    await pool.query(
      `UPDATE outbox_events 
       SET status = $1, attempts = $2, error_message = $3, updated_at = NOW() 
       WHERE id = $4`,
      [status, attempts, errorMessage, id]
    );
  }

  /**
   * Records a transient failure and schedules the next attempt.
   * The event stays pending but is invisible to fetchPending until due.
   */
  async scheduleRetry(id: number, attempts: number, errorMessage: string, delayMs: number): Promise<void> {
    await pool.query(
      `UPDATE outbox_events
       SET status = 'pending',
           attempts = $1,
           error_message = $2,
           failure_kind = 'transient',
           next_attempt_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE id = $4`,
      [attempts, errorMessage, delayMs, id]
    );
  }

  /**
   * Gives up on an event. It is never picked up again automatically; an
   * operator must inspect it and explicitly requeue it.
   */
  async deadLetter(id: number, attempts: number, errorMessage: string, kind: string): Promise<void> {
    await pool.query(
      `UPDATE outbox_events
       SET status = 'dead_letter',
           attempts = $1,
           error_message = $2,
           failure_kind = $3,
           dead_lettered_at = NOW(),
           next_attempt_at = NULL,
           updated_at = NOW()
       WHERE id = $4`,
      [attempts, errorMessage, kind, id]
    );
  }

  /** Dead letters, newest first, for the operations surface. */
  async listDeadLetters(limit: number, offset: number): Promise<any[]> {
    const { rows } = await pool.query(
      `SELECT id, aggregate_type, aggregate_id, event_type, payload, attempts,
              failure_kind, error_message, created_at, dead_lettered_at
       FROM outbox_events
       WHERE status = 'dead_letter'
       ORDER BY dead_lettered_at DESC NULLS LAST, id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows;
  }

  async countDeadLettersByKind(): Promise<Array<{ failure_kind: string | null; count: number }>> {
    const { rows } = await pool.query(
      `SELECT failure_kind, COUNT(*)::int AS count
       FROM outbox_events
       WHERE status = 'dead_letter'
       GROUP BY failure_kind
       ORDER BY count DESC`
    );
    return rows;
  }

  /**
   * Returns a dead letter to the queue after an operator has addressed the
   * underlying cause. Attempts are reset so it gets a fresh retry budget.
   */
  async requeueDeadLetter(id: number): Promise<boolean> {
    const { rowCount } = await pool.query(
      `UPDATE outbox_events
       SET status = 'pending',
           attempts = 0,
           failure_kind = NULL,
           dead_lettered_at = NULL,
           next_attempt_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND status = 'dead_letter'`,
      [id]
    );
    return (rowCount || 0) > 0;
  }
}
