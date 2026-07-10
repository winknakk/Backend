import { pool } from "../../adapters/postgres/PostgresAdapter";
import { Identity } from "../../domain/entities/Identity";
import { IIdentityRepository } from "../../domain/repositories/IIdentityRepository";
import { IdentityMapper } from "./mappers/IdentityMapper";

export class PostgresIdentityRepository implements IIdentityRepository {
  async findById(id: string): Promise<Identity | null> {
    const { rows } = await pool.query(
      `SELECT * FROM identities WHERE id = $1 LIMIT 1`,
      [parseInt(id)]
    );
    if (rows.length === 0) return null;
    return IdentityMapper.toDomain(rows[0]);
  }

  async findByChannelAndRef(channel: string, channelRef: string): Promise<Identity | null> {
    const { rows } = await pool.query(
      `SELECT * FROM identities 
       WHERE LOWER(channel) = LOWER($1) AND channel_ref = $2 
       LIMIT 1`,
      [channel, channelRef]
    );
    if (rows.length === 0) return null;
    return IdentityMapper.toDomain(rows[0]);
  }

  async save(identity: Identity): Promise<Identity> {
    const data = IdentityMapper.toPersistence(identity);
    const { rows } = await pool.query(
      `INSERT INTO identities (id, profile_id, channel, channel_ref, created_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))
       ON CONFLICT (id) DO UPDATE SET
         profile_id = EXCLUDED.profile_id,
         channel = EXCLUDED.channel,
         channel_ref = EXCLUDED.channel_ref,
         created_at = EXCLUDED.created_at
       RETURNING *`,
      [
        data.id,
        data.profile_id,
        data.channel,
        data.channel_ref,
        data.created_at
      ]
    );
    return IdentityMapper.toDomain(rows[0]);
  }
}
