import { pool } from "../../adapters/postgres/PostgresAdapter";
import { Conversation } from "../../domain/entities/Conversation";
import { IConversationRepository } from "../../domain/repositories/IConversationRepository";
import { ConversationMapper } from "./mappers/ConversationMapper";

export class PostgresConversationRepository implements IConversationRepository {
  async findById(id: string): Promise<Conversation | null> {
    const { rows } = await pool.query(
      `SELECT * FROM conversations WHERE id = $1 LIMIT 1`,
      [parseInt(id)]
    );
    if (rows.length === 0) return null;
    return ConversationMapper.toDomain(rows[0]);
  }

  async findActiveByIdentity(identityId: string, projectId: string): Promise<Conversation | null> {
    const { rows } = await pool.query(
      `SELECT * FROM conversations 
       WHERE identity_id = $1 AND project_id = $2 AND status = 'open'
       ORDER BY created_at DESC 
       LIMIT 1`,
      [parseInt(identityId), parseInt(projectId)]
    );
    if (rows.length === 0) return null;
    return ConversationMapper.toDomain(rows[0]);
  }

  async save(conversation: Conversation): Promise<Conversation> {
    const data = ConversationMapper.toPersistence(conversation);
    const { rows } = await pool.query(
      `INSERT INTO conversations (id, project_id, identity_id, status, handled_by, assigned_pm, channel, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), COALESCE($9, NOW()))
       ON CONFLICT (id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         identity_id = EXCLUDED.identity_id,
         status = EXCLUDED.status,
         handled_by = EXCLUDED.handled_by,
         assigned_pm = EXCLUDED.assigned_pm,
         channel = EXCLUDED.channel,
         updated_at = NOW()
       RETURNING *`,
      [
        data.id,
        data.project_id,
        data.identity_id,
        data.status,
        data.handled_by,
        data.assigned_pm,
        data.channel,
        data.created_at,
        data.updated_at
      ]
    );
    return ConversationMapper.toDomain(rows[0]);
  }

  async listPaginated(
    projectId: string,
    limit: number,
    cursor?: string
  ): Promise<{ rows: Conversation[]; nextCursor?: string }> {
    let query = `SELECT * FROM conversations WHERE project_id = $1`;
    const params: any[] = [parseInt(projectId), limit];

    if (cursor) {
      query += ` AND id > $3 ORDER BY id ASC LIMIT $2`;
      params.push(parseInt(cursor));
    } else {
      query += ` ORDER BY id ASC LIMIT $2`;
    }

    const { rows } = await pool.query(query, params);
    const list = rows.map(r => ConversationMapper.toDomain(r));

    let nextCursor: string | undefined;
    if (list.length === limit) {
      nextCursor = list[list.length - 1].id;
    }

    return { rows: list, nextCursor };
  }
}
