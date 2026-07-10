import { pool } from "../../adapters/postgres/PostgresAdapter";
import { Profile } from "../../domain/entities/Profile";
import { IProfileRepository } from "../../domain/repositories/IProfileRepository";
import { ProfileMapper } from "./mappers/ProfileMapper";

export class PostgresProfileRepository implements IProfileRepository {
  async findById(id: string): Promise<Profile | null> {
    const { rows } = await pool.query(
      `SELECT * FROM profiles WHERE id = $1 LIMIT 1`,
      [parseInt(id)]
    );
    if (rows.length === 0) return null;
    return ProfileMapper.toDomain(rows[0]);
  }

  async save(profile: Profile): Promise<Profile> {
    const data = ProfileMapper.toPersistence(profile);
    const { rows } = await pool.query(
      `INSERT INTO profiles (id, company_id, name, created_at)
       VALUES ($1, $2, $3, COALESCE($4, NOW()))
       ON CONFLICT (id) DO UPDATE SET
         company_id = EXCLUDED.company_id,
         name = EXCLUDED.name,
         created_at = EXCLUDED.created_at
       RETURNING *`,
      [
        data.id,
        data.company_id,
        data.name,
        data.created_at
      ]
    );
    return ProfileMapper.toDomain(rows[0]);
  }
}
