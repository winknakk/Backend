import { BaseEntity } from "./BaseEntity";
import { IDomainEvent } from "./BaseDomainEvent";

/**
 * BaseAggregate represents an aggregate root in Domain-Driven Design,
 * managing the collection and clearing of immutable domain events.
 */
export abstract class BaseAggregate<TId = string> extends BaseEntity<TId> {
  private _domainEvents: IDomainEvent[] = [];

  /**
   * Returns a read-only list of domain events accumulated in this transaction context.
   */
  get domainEvents(): readonly IDomainEvent[] {
    return Object.freeze([...this._domainEvents]);
  }

  /**
   * Registers a domain event to be dispatched later, freezing it to guarantee immutability.
   *
   * @param event - The domain event to register.
   */
  protected addDomainEvent(event: IDomainEvent): void {
    Object.freeze(event);
    this._domainEvents.push(event);
  }

  /**
   * Clears the collection of domain events.
   */
  public clearDomainEvents(): void {
    this._domainEvents = [];
  }
}
