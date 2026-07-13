import { BaseDomainEvent } from "../../shared/domain/BaseDomainEvent";

export class ConversationStartedEvent extends BaseDomainEvent {
  constructor(
    public readonly conversationId: string,
    public readonly projectId: string,
    public readonly identityId: string
  ) {
    super();
  }

  getAggregateId(): string {
    return this.conversationId;
  }
}

export class TakeoverStartedEvent extends BaseDomainEvent {
  constructor(
    public readonly conversationId: string,
    public readonly agentId: string,
    public readonly durationMs: number
  ) {
    super();
  }

  getAggregateId(): string {
    return this.conversationId;
  }
}

export class TakeoverEndedEvent extends BaseDomainEvent {
  constructor(public readonly conversationId: string) {
    super();
  }

  getAggregateId(): string {
    return this.conversationId;
  }
}

export class ConversationClosedEvent extends BaseDomainEvent {
  constructor(public readonly conversationId: string) {
    super();
  }

  getAggregateId(): string {
    return this.conversationId;
  }
}
