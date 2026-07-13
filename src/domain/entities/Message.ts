import { BaseEntity } from "../../shared/domain/BaseEntity";

export interface MessageProps {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt?: Date;
  metadata?: Record<string, any>;
  messageType?: string;
}

export class Message extends BaseEntity<string> {
  public readonly conversationId: string;
  public readonly role: string;
  public readonly content: string;
  public readonly createdAt: Date;
  public readonly metadata: Record<string, any>;
  public readonly messageType: string;

  constructor(props: MessageProps) {
    super(props.id);

    if (!props.conversationId) throw new Error("Conversation ID is required");
    if (!props.role) throw new Error("Message role is required");
    if (props.content === undefined || props.content === null) {
      throw new Error("Message content is required");
    }

    this.conversationId = props.conversationId;
    this.role = props.role;
    this.content = props.content;
    this.createdAt = props.createdAt || new Date();
    this.metadata = props.metadata || {};
    this.messageType = props.messageType || "text";
  }
}
