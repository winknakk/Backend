import { BaseAggregate } from "../../shared/domain/BaseAggregate";
import {
  TakeoverStartedEvent,
  TakeoverEndedEvent,
  ConversationClosedEvent
} from "./ConversationEvent";

export interface ConversationProps {
  id: string;
  projectId: string;
  identityId: string;
  status: string;
  handledBy: string;
  channel?: string;
  assignedPm?: string;
  takeoverExpiresAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export class Conversation extends BaseAggregate<string> {
  public readonly projectId: string;
  public readonly identityId: string;
  public readonly channel: string;
  private _status: string;
  private _handledBy: string;
  private _assignedPm?: string;
  private _takeoverExpiresAt?: Date | null;
  public readonly createdAt: Date;
  public readonly updatedAt: Date;

  constructor(props: ConversationProps) {
    super(props.id);

    if (!props.projectId) throw new Error("Project ID is required");
    if (!props.identityId) throw new Error("Identity ID is required");

    this.projectId = props.projectId;
    this.identityId = props.identityId;
    this.channel = props.channel || "WebChat";
    this._status = props.status || "open";
    this._handledBy = props.handledBy || "ai";
    this._assignedPm = props.assignedPm;
    this._takeoverExpiresAt = props.takeoverExpiresAt || null;
    this.createdAt = props.createdAt || new Date();
    this.updatedAt = props.updatedAt || new Date();
  }

  get status(): string {
    return this._status;
  }

  get handledBy(): string {
    return this._handledBy;
  }

  get assignedPm(): string | undefined {
    return this._assignedPm;
  }

  get takeoverExpiresAt(): Date | null | undefined {
    return this._takeoverExpiresAt;
  }

  /**
   * Enforces takeover lease logic and updates state.
   */
  public initiateTakeover(agentId: string, leaseDurationMs: number): void {
    if (this._status === "closed") {
      throw new Error("Cannot initiate takeover on a closed conversation");
    }
    const maxDurationMs = 2 * 60 * 60 * 1000; // Max 2 hours lease limit
    const finalDuration = Math.min(leaseDurationMs, maxDurationMs);

    this._handledBy = "human";
    this._assignedPm = agentId;
    this._takeoverExpiresAt = new Date(Date.now() + finalDuration);

    this.addDomainEvent(new TakeoverStartedEvent(this.id, agentId, finalDuration));
  }

  /**
   * Releases takeover lease and returns control to AI.
   */
  public releaseTakeover(): void {
    this._handledBy = "ai";
    this._takeoverExpiresAt = null;
    this._assignedPm = undefined;

    this.addDomainEvent(new TakeoverEndedEvent(this.id));
  }

  /**
   * Closes conversation session.
   */
  public close(): void {
    this._status = "closed";
    this.releaseTakeover();

    this.addDomainEvent(new ConversationClosedEvent(this.id));
  }
}
