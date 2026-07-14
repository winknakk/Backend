import { BaseDomainEvent } from "../../shared/domain/BaseDomainEvent";

/**
 * Interface contract for publishing Domain Events to the integration queue layer.
 */
export interface IIntegrationEventPublisher {
  /**
   * Translates and publishes Domain Events to the external message queues.
   */
  publish(events: BaseDomainEvent[]): Promise<void>;
}
