import { pool } from "../../adapters/postgres/PostgresAdapter";
import { Message } from "../../domain/entities/Message";
import { IMessageRepository } from "../../domain/repositories/IMessageRepository";
import { MessageMapper } from "./mappers/MessageMapper";

export class PostgresMessageRepository implements IMessageRepository {
  async save(message: Message): Promise<Message> {
    const data = MessageMapper.toPersistence(message);
    const { rows } = await pool.query(
      `INSERT INTO messages (id, conversation_id, role, content, created_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))
       ON CONFLICT (id) DO UPDATE SET
         conversation_id = EXCLUDED.conversation_id,
         role = EXCLUDED.role,
         content = EXCLUDED.content,
         created_at = EXCLUDED.created_at
       RETURNING *`,
      [
        data.id,
        data.conversation_id,
        data.role,
        data.content,
        data.created_at
      ]
    );
    return MessageMapper.toDomain(rows[0]);
  }

  async findRecentByConversationId(conversationId: string, limit: number): Promise<Message[]> {
    const { rows } = await pool.query(
      `SELECT * FROM messages 
       WHERE conversation_id = $1 
       ORDER BY created_at DESC, id DESC 
       LIMIT $2`,
      [parseInt(conversationId), limit]
    );
    // Return sorted in chronological order (oldest to newest)
    return rows.reverse().map(r => MessageMapper.toDomain(r));
  }
}
