import { TransactionManager } from "./TransactionManager";
import { BaseAggregate } from "../domain/BaseAggregate";

/**
 * UnitOfWork orchestrates business transactions and manages aggregate events.
 */
export class UnitOfWork {
  private aggregatesToPublish: BaseAggregate<unknown>[] = [];

  constructor(private readonly transactionManager: TransactionManager) {}

  /**
   * Registers an aggregate whose domain events should be published after a successful transaction commit.
   */
  public registerAggregate(aggregate: BaseAggregate<unknown>): void {
    if (!this.aggregatesToPublish.includes(aggregate)) {
      this.aggregatesToPublish.push(aggregate);
    }
  }

  /**
   * Executes a database transaction. If successful, triggers event publication.
   */
  public async execute<T>(
    fn: () => Promise<T>,
    publishEventsFn?: (events: any[]) => Promise<void>
  ): Promise<T> {
    this.aggregatesToPublish = [];

    const result = await this.transactionManager.executeTransaction(async () => {
      return await fn();
    });

    // If commit was successful and there are registered events, publish them
    if (publishEventsFn && this.aggregatesToPublish.length > 0) {
      const events = this.aggregatesToPublish.flatMap((a) => a.domainEvents);
      try {
        await publishEventsFn(events);
        this.aggregatesToPublish.forEach((a) => a.clearDomainEvents());
      } catch (err) {
        console.error("[UnitOfWork] Failed to publish domain events post-commit:", err);
      }
    }

    return result;
  }
}
