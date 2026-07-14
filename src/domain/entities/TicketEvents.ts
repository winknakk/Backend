import { BaseDomainEvent } from "../../shared/domain/BaseDomainEvent";

export class TicketCreatedEvent extends BaseDomainEvent {
  constructor(
    public readonly ticketId: number,
    public readonly readableId: string,
    public readonly conversationId: number,
    public readonly subject: string,
    public readonly projectId?: number,
    public readonly summary?: string
  ) {
    super();
  }

  getAggregateId(): string {
    return this.ticketId.toString();
  }
}

export class TicketEnrichedEvent extends BaseDomainEvent {
  constructor(
    public readonly ticketId: number,
    public readonly readableId: string,
    public readonly conversationId: number,
    public readonly projectId: number,
    public readonly aiConfidenceMetrics: {
      title: number;
      summary: number;
      duplicate: number;
    }
  ) {
    super();
  }

  getAggregateId(): string {
    return this.ticketId.toString();
  }
}

export class TicketSummaryUpdatedEvent extends BaseDomainEvent {
  constructor(
    public readonly ticketId: number,
    public readonly runningSummary: string,
    public readonly lastAiSummary: string
  ) {
    super();
  }

  getAggregateId(): string {
    return this.ticketId.toString();
  }
}

export class TicketMarkedDuplicateEvent extends BaseDomainEvent {
  constructor(
    public readonly ticketId: number,
    public readonly duplicateOfTicketId: number,
    public readonly duplicateScore: number,
    public readonly duplicateReason: string
  ) {
    super();
  }

  getAggregateId(): string {
    return this.ticketId.toString();
  }
}

export class TicketMergedEvent extends BaseDomainEvent {
  constructor(
    public readonly ticketId: number,
    public readonly primaryTicketId: number
  ) {
    super();
  }

  getAggregateId(): string {
    return this.ticketId.toString();
  }
}

export class TicketAssignedEvent extends BaseDomainEvent {
  constructor(
    public readonly ticketId: number,
    public readonly agentId: string
  ) {
    super();
  }

  getAggregateId(): string {
    return this.ticketId.toString();
  }
}

export class TicketClosedEvent extends BaseDomainEvent {
  constructor(public readonly ticketId: number) {
    super();
  }

  getAggregateId(): string {
    return this.ticketId.toString();
  }
}

export class TicketStatusChangedEvent extends BaseDomainEvent {
  constructor(
    public readonly ticketId: number,
    public readonly oldStatus: string,
    public readonly newStatus: string
  ) {
    super();
  }

  getAggregateId(): string {
    return this.ticketId.toString();
  }
}
