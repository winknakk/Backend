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
    const { rows } = await pool.query(
      `SELECT id, event_type, payload, status, attempts, error_message, created_at, updated_at
       FROM outbox_events
       WHERE status = 'pending'
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
}
