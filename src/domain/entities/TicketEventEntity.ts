import { BaseEntity } from "../../shared/domain/BaseEntity";

export interface TicketEventProps {
  id: number;
  ticketId: number;
  eventType: string;
  actor: string;
  source: string;
  correlationId?: string;
  payload: any;
  createdAt?: Date;
}

export class TicketEventEntity extends BaseEntity<number> {
  public readonly ticketId: number;
  public readonly eventType: string;
  public readonly actor: string;
  public readonly source: string;
  public readonly correlationId?: string;
  public readonly payload: any;
  public readonly createdAt: Date;

  constructor(props: TicketEventProps) {
    super(props.id);
    this.ticketId = props.ticketId;
    this.eventType = props.eventType;
    this.actor = props.actor;
    this.source = props.source;
    this.correlationId = props.correlationId;
    this.payload = props.payload;
    this.createdAt = props.createdAt || new Date();
  }
}
