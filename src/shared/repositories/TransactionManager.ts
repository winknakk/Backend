import pg from "pg";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { AsyncLocalStorage } from "async_hooks";

// Holds the active transaction client in AsyncLocalStorage for the thread context
export const transactionStorage = new AsyncLocalStorage<pg.PoolClient>();

export class TransactionManager {
  /**
   * Runs the given callback inside a PostgreSQL database transaction.
   * If an active transaction already exists in the thread context, it joins it.
   */
  public async executeTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const existingClient = transactionStorage.getStore();
    if (existingClient) {
      // Already inside a transaction, join it
      return await fn();
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await transactionStorage.run(client, async () => {
        return await fn();
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Retrieves the active database connection client.
   * Falls back to the global pool if no transaction is active in this execution thread.
   */
  public getClient(): pg.Pool | pg.PoolClient {
    const client = transactionStorage.getStore();
    return client || pool;
  }
}
