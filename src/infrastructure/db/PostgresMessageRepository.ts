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

  /**
   * One page of a conversation, newest-first internally, returned oldest-first.
   *
   * `findRecentByConversationId` can only ever return the newest N, so anything
   * older than that window was unreachable by any client — a conversation with
   * 135 rows served 50 and no way to ask for the rest.
   *
   * The cursor is a keyset on `(created_at, id)`, the exact tuple the ORDER BY
   * uses. An `id`-only cursor would be wrong here: the leading sort key is
   * `created_at`, so a row whose timestamp does not follow its id (a backfill,
   * an imported transcript) could be skipped or served twice while paging.
   *
   * `limit + 1` rows are read so `hasMore` is known without a second COUNT over
   * the conversation.
   */
  async findPageByConversationId(
    conversationId: string,
    limit: number,
    beforeId?: number
  ): Promise<{ messages: Message[]; hasMore: boolean; nextCursor: string | null }> {
    const params: unknown[] = [parseInt(conversationId, 10)];
    let cursorClause = "";
    if (beforeId !== undefined && Number.isFinite(beforeId)) {
      params.push(beforeId);
      cursorClause = `
         AND (created_at, id) < (SELECT created_at, id FROM messages WHERE id = $${params.length})`;
    }
    params.push(limit + 1);

    const { rows } = await pool.query(
      `SELECT * FROM messages
        WHERE conversation_id = $1${cursorClause}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
      params
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    // Oldest row of this page: the cursor a caller passes back as `before`.
    const nextCursor = page.length > 0 ? String(page[page.length - 1].id) : null;

    return {
      messages: page.reverse().map((r) => MessageMapper.toDomain(r)),
      hasMore,
      nextCursor,
    };
  }
}
