import { BaseEntity } from "../domain/BaseEntity";
import { TransactionManager } from "./TransactionManager";

/**
 * BaseRepository defines the standard interface and database handle
 * for all PostgreSQL repository classes.
 */
export abstract class BaseRepository<TEntity extends BaseEntity<TId>, TId = string> {
  constructor(protected readonly transactionManager: TransactionManager) {}

  /**
   * Retrieves the active database execution client (transaction client or pool).
   */
  protected get db() {
    return this.transactionManager.getClient();
  }

  abstract findById(id: TId): Promise<TEntity | null>;
  abstract save(entity: TEntity): Promise<TEntity>;
}
