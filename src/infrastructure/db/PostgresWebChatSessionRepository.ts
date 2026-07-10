import { pool } from "../../adapters/postgres/PostgresAdapter";
import { WebChatSession } from "../../domain/entities/WebChatSession";
import { IWebChatSessionRepository } from "../../domain/repositories/IWebChatSessionRepository";
import { WebChatSessionMapper } from "./mappers/WebChatSessionMapper";

export class PostgresWebChatSessionRepository implements IWebChatSessionRepository {
  async findByToken(token: string): Promise<WebChatSession | null> {
    const { rows } = await pool.query(
      `SELECT * FROM webchat_sessions WHERE session_token = $1 LIMIT 1`,
      [token]
    );
    if (rows.length === 0) return null;
    return WebChatSessionMapper.toDomain(rows[0]);
  }

  async save(session: WebChatSession): Promise<WebChatSession> {
    const data = WebChatSessionMapper.toPersistence(session);
    const { rows } = await pool.query(
      `INSERT INTO webchat_sessions (id, identity_id, session_token, created_at, last_active_at)
       VALUES ($1, $2, $3, COALESCE($4, NOW()), COALESCE($5, NOW()))
       ON CONFLICT (id) DO UPDATE SET
         identity_id = EXCLUDED.identity_id,
         session_token = EXCLUDED.session_token,
         last_active_at = NOW()
       RETURNING *`,
      [
        data.id,
        data.identity_id,
        data.session_token,
        data.created_at,
        data.last_active_at
      ]
    );
    return WebChatSessionMapper.toDomain(rows[0]);
  }
}
