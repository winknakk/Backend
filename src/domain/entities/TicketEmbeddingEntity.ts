import { BaseEntity } from "../../shared/domain/BaseEntity";

export interface TicketEmbeddingProps {
  id: number;
  ticketId: number;
  embedding: number[];
  createdAt?: Date;
}

export class TicketEmbeddingEntity extends BaseEntity<number> {
  public readonly ticketId: number;
  public readonly embedding: number[];
  public readonly createdAt: Date;

  constructor(props: TicketEmbeddingProps) {
    super(props.id);
    this.ticketId = props.ticketId;
    this.embedding = props.embedding;
    this.createdAt = props.createdAt || new Date();
  }
}
