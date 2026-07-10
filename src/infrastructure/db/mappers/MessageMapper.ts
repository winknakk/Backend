import { Message } from "../../../domain/entities/Message";

export class MessageMapper {
  static toDomain(raw: any): Message {
    return new Message({
      id: String(raw.id),
      conversationId: String(raw.conversation_id),
      role: raw.role,
      content: raw.content,
      createdAt: raw.created_at ? new Date(raw.created_at) : undefined
    });
  }

  static toPersistence(domain: Message): any {
    return {
      id: parseInt(domain.id),
      conversation_id: parseInt(domain.conversationId),
      role: domain.role,
      content: domain.content,
      created_at: domain.createdAt ? domain.createdAt.toISOString() : null
    };
  }
}
