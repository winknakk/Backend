import { TransactionManager } from "./TransactionManager";

/**
 * RepositoryFactory dynamically instantiates repository classes
 * and injects the active TransactionManager connection.
 */
export class RepositoryFactory {
  constructor(private readonly transactionManager: TransactionManager) {}

  /**
   * Instantiates a repository class.
   */
  public createRepository<T>(
    repoClass: new (tm: TransactionManager) => T
  ): T {
    return new repoClass(this.transactionManager);
  }
}
