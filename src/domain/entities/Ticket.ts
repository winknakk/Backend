import { BaseAggregate } from "../../shared/domain/BaseAggregate";
import {
  TicketCreatedEvent,
  TicketEnrichedEvent,
  TicketSummaryUpdatedEvent,
  TicketMarkedDuplicateEvent,
  TicketMergedEvent,
  TicketAssignedEvent,
  TicketClosedEvent,
  TicketStatusChangedEvent,
} from "./TicketEvents";
import {
  TERMINAL_STATUSES,
  TicketLifecycleStatus,
  TransitionActor,
  canTransition,
  isLifecycleStatus,
} from "../ticket/TicketLifecycle";

export const EnrichmentStates = ["PENDING", "RUNNING", "PARTIAL", "COMPLETED", "FAILED"] as const;
export type EnrichmentState = (typeof EnrichmentStates)[number];

export interface TicketProps {
  id: number;
  ticketId: string;
  conversationId: number;
  projectId?: number | null;
  subject: string;
  summary?: string;
  status: string;
  priority?: string;
  severity?: string;
  assignedPm?: string;
  createdVia?: string;
  planeIssueId?: string;
  dueDate?: Date | null;
  createdAt?: Date;

  // Ticket Intelligence additions
  title?: string;
  originalProblemStatement?: string;
  runningSummary?: string;
  lastAiSummary?: string;
  duplicateOfTicketId?: number | null;
  duplicateScore?: number;
  duplicateReason?: string;
  aiConfidenceMetrics?: {
    title: number;
    summary: number;
    duplicate: number;
  };
  searchableText?: string;
  enrichmentState?: EnrichmentState;

  // Creator Attribution & Cancellation Safeguards
  createdByType?: string;
  createdByTypes?: string;
  createdByName?: string;
  cancellationReason?: string;
}

export class Ticket extends BaseAggregate<number> {
  public readonly ticketId: string;
  public readonly conversationId: number;
  private _projectId?: number | null;
  private _subject: string;
  private _summary?: string;
  private _status: string;
  private _priority?: string;
  private _severity?: string;
  private _assignedPm?: string;
  private _createdVia?: string;
  private _planeIssueId?: string;
  private _dueDate?: Date | null;
  public readonly createdAt: Date;

  // New Ticket Intelligence props
  private _title?: string;
  private _originalProblemStatement?: string;
  private _runningSummary?: string;
  private _lastAiSummary?: string;
  private _duplicateOfTicketId?: number | null;
  private _duplicateScore: number;
  private _duplicateReason?: string;
  private _aiConfidenceMetrics: {
    title: number;
    summary: number;
    duplicate: number;
  };
  private _searchableText?: string;
  private _enrichmentState: EnrichmentState;

  // Creator Attribution & Cancellation Safeguards
  private _createdByType: string;
  private _createdByName?: string;
  private _cancellationReason?: string;

  constructor(props: TicketProps) {
    super(props.id);
    if (!props.ticketId) throw new Error("Ticket readable ID is required");
    if (!props.conversationId) throw new Error("Conversation ID is required");
    if (!props.subject || props.subject.length < 5) {
      throw new Error("Subject must be at least 5 characters long");
    }

    this.ticketId = props.ticketId;
    this.conversationId = props.conversationId;
    this._projectId = props.projectId;
    this._subject = props.subject;
    this._summary = props.summary;
    this._status = props.status || "NEW";
    this._priority = props.priority;
    this._severity = props.severity;
    this._assignedPm = props.assignedPm;
    this._createdVia = props.createdVia || "ai";
    this._planeIssueId = props.planeIssueId;
    this._dueDate = props.dueDate;
    this.createdAt = props.createdAt || new Date();

    this._title = props.title;
    this._originalProblemStatement = props.originalProblemStatement;
    this._runningSummary = props.runningSummary;
    this._lastAiSummary = props.lastAiSummary;
    this._duplicateOfTicketId = props.duplicateOfTicketId;
    this._duplicateScore = props.duplicateScore || 0.00;
    this._duplicateReason = props.duplicateReason;
    this._aiConfidenceMetrics = props.aiConfidenceMetrics || {
      title: 0.00,
      summary: 0.00,
      duplicate: 0.00,
    };
    this._searchableText = props.searchableText;
    this._enrichmentState = this.normalizeEnrichmentState(props.enrichmentState);
    this._createdByType = props.createdByType || props.createdByTypes || "CUSTOMER";
    this._createdByName = props.createdByName;
    this._cancellationReason = props.cancellationReason;
  }

  // Getters
  get projectId(): number | null | undefined { return this._projectId; }
  get subject(): string { return this._subject; }
  get summary(): string | undefined { return this._summary; }
  get status(): string { return this._status; }
  get priority(): string | undefined { return this._priority; }
  get severity(): string | undefined { return this._severity; }
  get assignedPm(): string | undefined { return this._assignedPm; }
  get createdVia(): string | undefined { return this._createdVia; }
  get planeIssueId(): string | undefined { return this._planeIssueId; }
  get dueDate(): Date | null | undefined { return this._dueDate; }

  get title(): string | undefined { return this._title; }
  get originalProblemStatement(): string | undefined { return this._originalProblemStatement; }
  get runningSummary(): string | undefined { return this._runningSummary; }
  get lastAiSummary(): string | undefined { return this._lastAiSummary; }
  get duplicateOfTicketId(): number | null | undefined { return this._duplicateOfTicketId; }
  get duplicateScore(): number { return this._duplicateScore; }
  get duplicateReason(): string | undefined { return this._duplicateReason; }
  get aiConfidenceMetrics() { return this._aiConfidenceMetrics; }
  get searchableText(): string | undefined { return this._searchableText; }
  get enrichmentState(): EnrichmentState { return this._enrichmentState; }
  get createdByType(): string { return this._createdByType; }
  get createdByName(): string | undefined { return this._createdByName; }
  get cancellationReason(): string | undefined { return this._cancellationReason; }

  // Static Factory Method
  public static create(props: Omit<TicketProps, "id"> & { id?: number }): Ticket {
    const ticket = new Ticket({
      ...props,
      id: props.id || 0,
    });
    ticket.addDomainEvent(
      new TicketCreatedEvent(
        ticket.id!,
        ticket.ticketId,
        ticket.conversationId,
        ticket.subject,
        ticket.projectId ?? undefined,
        ticket.summary ?? undefined
      )
    );
    return ticket;
  }

  // Domain Actions

  private isTerminalStatus(): boolean {
    // Lifecycle terminal states. RESOLVED is deliberately absent: a resolved
    // ticket is still open business until the customer confirms it.
    return TERMINAL_STATUSES.includes(this._status as TicketLifecycleStatus);
  }

  private normalizeEnrichmentState(state?: string): EnrichmentState {
    return EnrichmentStates.includes(state as EnrichmentState) ? (state as EnrichmentState) : "PENDING";
  }

  private recalculateEnrichmentState(): void {
    const hasTitle = this._aiConfidenceMetrics.title > 0.0;
    const hasSummary = this._aiConfidenceMetrics.summary > 0.0;
    const hasDuplicate = this._aiConfidenceMetrics.duplicate > 0.0;

    const completedCount = (hasTitle ? 1 : 0) + (hasSummary ? 1 : 0) + (hasDuplicate ? 1 : 0);

    if (completedCount === 3) {
      if (this._enrichmentState !== "COMPLETED") {
        this._enrichmentState = "COMPLETED";
        this.addDomainEvent(
          new TicketEnrichedEvent(
            this.id!,
            this.ticketId,
            this.conversationId,
            this._projectId || 1,
            this._aiConfidenceMetrics
          )
        );
      }
    } else if (completedCount > 0) {
      this._enrichmentState = "PARTIAL";
    } else {
      this._enrichmentState = "PENDING";
    }
  }

  public updateAiTitle(title: string, confidence: number): void {
    if (this.isTerminalStatus()) {
      throw new Error("Cannot update title on a closed ticket");
    }
    this._title = title;
    this._aiConfidenceMetrics = {
      ...this._aiConfidenceMetrics,
      title: confidence,
    };
    this.recalculateEnrichmentState();
  }

  public updateAiSummaryWithConfidence(
    runningSummary: string,
    lastAiSummary: string,
    confidence: number
  ): void {
    if (this.isTerminalStatus()) {
      throw new Error("Cannot update summary on a closed ticket");
    }
    this._runningSummary = runningSummary;
    this._lastAiSummary = lastAiSummary;
    this._aiConfidenceMetrics = {
      ...this._aiConfidenceMetrics,
      summary: confidence,
    };
    this.addDomainEvent(new TicketSummaryUpdatedEvent(this.id, runningSummary, lastAiSummary));
    this.recalculateEnrichmentState();
  }

  public updateSummary(runningSummary: string, lastAiSummary: string): void {
    if (this.isTerminalStatus()) {
      throw new Error("Cannot update summary on a closed ticket");
    }
    this._runningSummary = runningSummary;
    this._lastAiSummary = lastAiSummary;
    this.addDomainEvent(new TicketSummaryUpdatedEvent(this.id, runningSummary, lastAiSummary));
  }

  public markDuplicate(duplicateOfTicketId: number, score: number, reason: string): void {
    if (this.id !== 0 && duplicateOfTicketId === this.id) {
      throw new Error("A ticket cannot be a duplicate of itself");
    }
    if (this.isTerminalStatus()) {
      throw new Error("Closed tickets cannot be marked as duplicate");
    }
    this._duplicateOfTicketId = duplicateOfTicketId;
    this._duplicateScore = score;
    this._duplicateReason = reason;
    // "merged" is not part of the approved lifecycle vocabulary and would
    // violate tickets_status_lifecycle_check. A merged ticket is a duplicate
    // folded into another; duplicate_of_ticket_id already records the link,
    // so CANCELLED expresses it without inventing a twelfth status.
    this._status = "CANCELLED";
    this._aiConfidenceMetrics = {
      ...this._aiConfidenceMetrics,
      duplicate: score,
    };
    this.addDomainEvent(new TicketMarkedDuplicateEvent(this.id, duplicateOfTicketId, score, reason));
    this.recalculateEnrichmentState();
  }

  public recordDuplicateCheckCompleted(confidence: number): void {
    if (this.isTerminalStatus()) {
      throw new Error("Cannot update duplicate check on a closed ticket");
    }
    this._aiConfidenceMetrics = {
      ...this._aiConfidenceMetrics,
      duplicate: confidence,
    };
    this.recalculateEnrichmentState();
  }

  public cancelTicket(reason: string): void {
    if (!reason || reason.trim().length < 10) {
      throw new Error("A valid cancellation reason of at least 10 characters is required.");
    }
    this._status = "CANCELLED";
    this._cancellationReason = reason.trim();
    this.addDomainEvent(new TicketStatusChangedEvent(this.id!, this.ticketId, "CANCELLED"));
  }

  public restore(): void {
    this._status = "REOPENED";
    this._cancellationReason = undefined;
    this.addDomainEvent(new TicketStatusChangedEvent(this.id!, this.ticketId, "REOPENED"));
  }

  public merge(primaryTicketId: number): void {
    if (this.id !== 0 && primaryTicketId === this.id) {
      throw new Error("Cannot merge a ticket into itself");
    }
    if (this.isTerminalStatus()) {
      throw new Error("Cannot merge closed tickets");
    }
    this._duplicateOfTicketId = primaryTicketId;
    // "merged" is not one of the eleven lifecycle statuses and would fail
    // tickets_status_lifecycle_check. duplicate_of_ticket_id already records
    // that this is a duplicate; CANCELLED is its lifecycle end state.
    this._status = "CANCELLED";
    this.addDomainEvent(new TicketMergedEvent(this.id, primaryTicketId));
  }

  public assign(agentId: string): void {
    if (this.isTerminalStatus()) {
      throw new Error("Cannot assign closed ticket");
    }
    this._assignedPm = agentId;
    this.addDomainEvent(new TicketAssignedEvent(this.id, agentId));
  }

  /**
   * Marks engineering work complete. This produces RESOLVED, not CLOSED:
   * closing requires the customer to confirm, which only
   * TicketStateMachine can record.
   */
  public close(): void {
    if (this.isTerminalStatus()) {
      throw new Error("Ticket is already closed");
    }
    this._status = "RESOLVED";
    this.addDomainEvent(new TicketClosedEvent(this.id));
  }

  public reopen(): void {
    if (!["RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED", "CANCELLED"].includes(this._status)) {
      return;
    }
    const oldStatus = this._status;
    this._status = "REOPENED";
    this.addDomainEvent(new TicketStatusChangedEvent(this.id, oldStatus, "REOPENED"));
  }

  /**
   * Delegates to the shared lifecycle rules rather than keeping a second,
   * divergent transition table. The old table used Plane's lowercase
   * vocabulary ("backlog", "in progress", "merged"), which no longer matches
   * what this column stores.
   */
  public changeStatus(newStatus: string, actor: TransitionActor = "operator"): void {
    if (!isLifecycleStatus(newStatus)) {
      throw new Error(`Invalid status '${newStatus}'`);
    }
    if (!isLifecycleStatus(this._status)) {
      throw new Error(`Ticket holds a non-lifecycle status '${this._status}'`);
    }

    const check = canTransition(this._status as TicketLifecycleStatus, newStatus, actor);
    if (!check.allowed) {
      throw new Error(check.reason || `Invalid status transition from ${this._status} to ${newStatus}`);
    }

    const oldStatus = this._status;
    this._status = newStatus;
    this.addDomainEvent(new TicketStatusChangedEvent(this.id, oldStatus, newStatus));
  }

  public updatePriority(priority: string, resolveHours: number): void {
    if (this.isTerminalStatus()) {
      throw new Error("Cannot update priority on a closed ticket");
    }
    this._priority = priority;
    this._dueDate = new Date(Date.now() + resolveHours * 60 * 60 * 1000);
  }

  // Repository-specific ID update hook
  public assignDatabaseId(id: number): void {
    if (this.id !== 0) {
      throw new Error("Cannot re-assign database ID to an already persisted aggregate");
    }
    (this as any).id = id;

    // Recreate any TicketCreatedEvent, TicketAssignedEvent, or TicketSummaryUpdatedEvent in the events array to carry the correct database ID
    const events = (this as any)._domainEvents || [];
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev instanceof TicketCreatedEvent && ev.ticketId === 0) {
        const newEv = new TicketCreatedEvent(
          id,
          ev.readableId,
          ev.conversationId,
          ev.subject,
          ev.projectId,
          ev.summary
        );
        (newEv as any).occurredAt = ev.occurredAt;
        events[i] = newEv;
      } else if (ev instanceof TicketAssignedEvent && ev.ticketId === 0) {
        const newEv = new TicketAssignedEvent(id, ev.agentId);
        (newEv as any).occurredAt = ev.occurredAt;
        events[i] = newEv;
      } else if (ev instanceof TicketSummaryUpdatedEvent && ev.ticketId === 0) {
        const newEv = new TicketSummaryUpdatedEvent(id, ev.runningSummary, ev.lastAiSummary);
        (newEv as any).occurredAt = ev.occurredAt;
        events[i] = newEv;
      }
    }
  }
}
