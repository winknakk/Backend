import { pool } from "../adapters/postgres/PostgresAdapter";
import { IVectorStore } from "./types";

export class PgVectorStore implements IVectorStore {
  async addDocuments(documents: Array<{ id: string; content: string; metadata?: any }>): Promise<void> {
    for (const doc of documents) {
      const embedding = doc.metadata?.embedding;
      if (!Array.isArray(embedding)) {
        throw new Error(`Document '${doc.id}' is missing metadata.embedding for PgVectorStore.`);
      }

      await pool.query(
        `INSERT INTO document_embeddings (doc_id, content, metadata, embedding)
         VALUES ($1, $2, $3, $4::vector)
         ON CONFLICT (doc_id) DO UPDATE SET
           content = EXCLUDED.content,
           metadata = EXCLUDED.metadata,
           embedding = EXCLUDED.embedding,
           updated_at = NOW()`,
        [doc.id, doc.content, JSON.stringify(doc.metadata || {}), this.toVectorLiteral(embedding)]
      );
    }
  }

  async similaritySearch(
    queryVector: number[],
    k: number = 5
  ): Promise<Array<{ id: string; content: string; score: number; metadata?: any }>> {
    const { rows } = await pool.query(
      `SELECT doc_id, content, metadata, 1 - (embedding <=> $1::vector) AS score
       FROM document_embeddings
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [this.toVectorLiteral(queryVector), k]
    );

    return rows.map((row: any) => ({
      id: row.doc_id,
      content: row.content,
      score: Number(row.score),
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
    }));
  }

  private toVectorLiteral(vector: number[]): string {
    return `[${vector.map((value) => Number(value).toFixed(8)).join(",")}]`;
  }
}
