export interface OutboxEventPersistence {
  id: number;
  event_type: string;
  payload: any;
  status: string;
  attempts: number;
  error_message?: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Interface contract for managing the PostgreSQL transactional outbox.
 */
export interface IOutboxRepository {
  /**
   * Fetches the oldest pending outbox events up to the specified limit.
   */
  fetchPending(limit: number): Promise<OutboxEventPersistence[]>;

  /**
   * Marks a specific outbox event as successfully processed.
   */
  markProcessed(id: number): Promise<void>;

  /**
   * Increments attempt count, records the error message, and updates event status.
   */
  updateAttempts(id: number, attempts: number, errorMessage: string, status: string): Promise<void>;
}
