/**
 * IDomainEvent defines the contract that all domain events must satisfy.
 */
export interface IDomainEvent {
  /** The timestamp when the domain event occurred */
  readonly occurredAt: Date;
  /** Returns the string identifier of the aggregate generating the event */
  getAggregateId(): string;
}

/**
 * BaseDomainEvent serves as the abstract base class implementing basic event attributes.
 */
export abstract class BaseDomainEvent implements IDomainEvent {
  /** The timestamp when the event occurred */
  public readonly occurredAt: Date;

  /**
   * Initializes a new BaseDomainEvent instance.
   */
  constructor() {
    this.occurredAt = new Date();
  }

  /**
   * Returns the string identifier of the aggregate generating the event.
   */
  public abstract getAggregateId(): string;
}
