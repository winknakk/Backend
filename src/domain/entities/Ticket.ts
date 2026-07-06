export interface TicketProps {
  id: string;
  ticketId: string;
  conversationId: string;
  projectId?: string | null;
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
}

export class Ticket {
  public readonly id: string;
  public readonly ticketId: string;
  public readonly conversationId: string;
  private _projectId?: string | null;
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

  constructor(props: TicketProps) {
    if (!props.id) throw new Error("Ticket DB primary ID is required");
    if (!props.ticketId) throw new Error("Ticket readable ID is required");
    if (!props.conversationId) throw new Error("Conversation ID is required");
    if (!props.subject || props.subject.length < 5) {
      throw new Error("Subject must be at least 5 characters long");
    }

    this.id = props.id;
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
  }

  get projectId(): string | null | undefined {
    return this._projectId;
  }

  get subject(): string {
    return this._subject;
  }

  get summary(): string | undefined {
    return this._summary;
  }

  get status(): string {
    return this._status;
  }

  get priority(): string | undefined {
    return this._priority;
  }

  get severity(): string | undefined {
    return this._severity;
  }

  get assignedPm(): string | undefined {
    return this._assignedPm;
  }

  get createdVia(): string | undefined {
    return this._createdVia;
  }

  get planeIssueId(): string | undefined {
    return this._planeIssueId;
  }

  get dueDate(): Date | null | undefined {
    return this._dueDate;
  }

  /**
   * Resolves the ticket.
   */
  public resolve(): void {
    this._status = "resolved";
  }

  /**
   * Updates ticket priority and computes new due date.
   */
  public updatePriority(priority: string, resolveHours: number): void {
    this._priority = priority;
    this._dueDate = new Date(Date.now() + resolveHours * 60 * 60 * 1000);
  }
}
