export interface MessageProps {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt?: Date;
}

export class Message {
  public readonly id: string;
  public readonly conversationId: string;
  public readonly role: string;
  public readonly content: string;
  public readonly createdAt: Date;

  constructor(props: MessageProps) {
    if (!props.id) throw new Error("Message ID is required");
    if (!props.conversationId) throw new Error("Conversation ID is required");
    if (!props.role) throw new Error("Message role is required");
    if (props.content === undefined || props.content === null) {
      throw new Error("Message content is required");
    }

    this.id = props.id;
    this.conversationId = props.conversationId;
    this.role = props.role;
    this.content = props.content;
    this.createdAt = props.createdAt || new Date();
  }
}
