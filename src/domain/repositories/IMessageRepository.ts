import { Message } from "../entities/Message";

export interface IMessageRepository {
  /**
   * Saves a message domain entity.
   */
  save(message: Message): Promise<Message>;

  /**
   * Retrieves the most recent messages inside a conversation up to a specified limit.
   */
  findRecentByConversationId(conversationId: string, limit: number): Promise<Message[]>;
}
