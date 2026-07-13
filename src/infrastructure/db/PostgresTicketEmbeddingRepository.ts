import { BaseRepository } from "../../shared/repositories/BaseRepository";
import { TicketEmbeddingEntity } from "../../domain/entities/TicketEmbeddingEntity";

export class PostgresTicketEmbeddingRepository extends BaseRepository<TicketEmbeddingEntity, number> {
  async findById(id: number): Promise<TicketEmbeddingEntity | null> {
    const { rows } = await this.db.query(
      "SELECT * FROM ticket_embeddings WHERE id = $1 LIMIT 1",
      [id]
    );
    if (rows.length === 0) return null;
    return this.mapRowToEntity(rows[0]);
  }

  async findByTicketId(ticketId: number): Promise<TicketEmbeddingEntity | null> {
    const { rows } = await this.db.query(
      "SELECT * FROM ticket_embeddings WHERE ticket_id = $1 LIMIT 1",
      [ticketId]
    );
    if (rows.length === 0) return null;
    return this.mapRowToEntity(rows[0]);
  }

  async save(entity: TicketEmbeddingEntity): Promise<TicketEmbeddingEntity> {
    // Format vector numeric array as '[0.1,0.2,0.3]'
    const vectorString = `[${entity.embedding.join(",")}]`;

    // Check if duplicate already exists in DB
    const existing = await this.findByTicketId(entity.ticketId);

    if (!existing) {
      const { rows } = await this.db.query(
        `INSERT INTO ticket_embeddings (ticket_id, embedding, created_at)
         VALUES ($1, $2, COALESCE($3, NOW()))
         RETURNING id`,
        [entity.ticketId, vectorString, entity.createdAt ? entity.createdAt.toISOString() : null]
      );
      return new TicketEmbeddingEntity({
        ...entity,
        id: rows[0].id,
      });
    } else {
      await this.db.query(
        `UPDATE ticket_embeddings SET
          embedding = $1
         WHERE ticket_id = $2`,
        [vectorString, entity.ticketId]
      );
      return new TicketEmbeddingEntity({
        ...entity,
        id: existing.id,
      });
    }
  }

  async delete(ticketId: number): Promise<void> {
    await this.db.query(
      "DELETE FROM ticket_embeddings WHERE ticket_id = $1",
      [ticketId]
    );
  }

  private mapRowToEntity(row: any): TicketEmbeddingEntity {
    let embeddingArr: number[] = [];
    if (typeof row.embedding === "string") {
      const clean = row.embedding.replace("[", "").replace("]", "").trim();
      if (clean) {
        embeddingArr = clean.split(",").map(Number);
      }
    } else if (Array.isArray(row.embedding)) {
      embeddingArr = row.embedding.map(Number);
    }

    return new TicketEmbeddingEntity({
      id: row.id,
      ticketId: row.ticket_id,
      embedding: embeddingArr,
      createdAt: new Date(row.created_at),
    });
  }
}
