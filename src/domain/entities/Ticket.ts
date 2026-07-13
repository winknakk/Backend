import { BaseAggregate } from "../../shared/domain/BaseAggregate";
import {
  TicketCreatedEvent,
  TicketSummaryUpdatedEvent,
  TicketMarkedDuplicateEvent,
  TicketMergedEvent,
  TicketAssignedEvent,
  TicketClosedEvent,
  TicketStatusChangedEvent,
} from "./TicketEvents";

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
    this._status = props.status || "open";
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
        ticket.subject
      )
    );
    return ticket;
  }

  // Domain Actions

  public updateSummary(runningSummary: string, lastAiSummary: string): void {
    if (this._status.toLowerCase() === "closed") {
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
    if (this._status.toLowerCase() === "closed") {
      throw new Error("Closed tickets cannot be marked as duplicate");
    }
    this._duplicateOfTicketId = duplicateOfTicketId;
    this._duplicateScore = score;
    this._duplicateReason = reason;
    this._status = "merged"; // Transition status to merged automatically
    this.addDomainEvent(new TicketMarkedDuplicateEvent(this.id, duplicateOfTicketId, score, reason));
  }

  public merge(primaryTicketId: number): void {
    if (this.id !== 0 && primaryTicketId === this.id) {
      throw new Error("Cannot merge a ticket into itself");
    }
    if (this._status.toLowerCase() === "closed") {
      throw new Error("Cannot merge closed tickets");
    }
    this._duplicateOfTicketId = primaryTicketId;
    this._status = "merged";
    this.addDomainEvent(new TicketMergedEvent(this.id, primaryTicketId));
  }

  public assign(agentId: string): void {
    if (this._status.toLowerCase() === "closed") {
      throw new Error("Cannot assign closed ticket");
    }
    this._assignedPm = agentId;
    this.addDomainEvent(new TicketAssignedEvent(this.id, agentId));
  }

  public close(): void {
    if (this._status.toLowerCase() === "closed") {
      throw new Error("Ticket is already closed");
    }
    this._status = "closed";
    this.addDomainEvent(new TicketClosedEvent(this.id));
  }

  public changeStatus(newStatus: string): void {
    const current = this._status.toLowerCase();
    const target = newStatus.toLowerCase();

    if (current === "closed") {
      throw new Error("Closed tickets cannot transition status");
    }

    // Validate state transitions
    const allowedTransitions: Record<string, string[]> = {
      new: ["open", "closed"],
      open: ["in_progress", "waiting_customer", "waiting_agent", "resolved", "closed", "merged"],
      in_progress: ["waiting_customer", "waiting_agent", "resolved", "closed"],
      waiting_customer: ["open", "resolved", "closed"],
      waiting_agent: ["open", "in_progress", "resolved", "closed"],
      resolved: ["open", "closed"],
      merged: ["open", "closed"],
    };

    const allowed = allowedTransitions[current] || [];
    if (!allowed.includes(target)) {
      throw new Error(`Invalid status transition from ${this._status} to ${newStatus}`);
    }

    const oldStatus = this._status;
    this._status = newStatus;
    this.addDomainEvent(new TicketStatusChangedEvent(this.id, oldStatus, newStatus));
  }

  public updatePriority(priority: string, resolveHours: number): void {
    if (this._status.toLowerCase() === "closed") {
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
  }
}
