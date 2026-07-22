import { Pool } from "pg";
import { MessageAttachment, AttachmentStatus } from "../../domain/entities/MessageAttachment";
import { IMessageAttachmentRepository } from "../../domain/repositories/IMessageAttachmentRepository";

export class PostgresMessageAttachmentRepository implements IMessageAttachmentRepository {
  constructor(private pool: Pool) {}

  async create(attachment: MessageAttachment): Promise<MessageAttachment> {
    const query = `
      INSERT INTO public.message_attachments 
        (message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata, created_at)
      VALUES 
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, created_at;
    `;

    const values = [
      attachment.messageId,
      attachment.fileUrl,
      attachment.thumbnailUrl || null,
      attachment.fileName,
      attachment.fileType,
      attachment.fileSize,
      attachment.storageKey,
      attachment.attachmentStatus,
      JSON.stringify(attachment.metadata),
      attachment.createdAt
    ];

    const result = await this.pool.query(query, values);
    const row = result.rows[0];

    return new MessageAttachment({
      id: row.id,
      messageId: attachment.messageId,
      fileUrl: attachment.fileUrl,
      thumbnailUrl: attachment.thumbnailUrl,
      fileName: attachment.fileName,
      fileType: attachment.fileType,
      fileSize: attachment.fileSize,
      storageKey: attachment.storageKey,
      attachmentStatus: attachment.attachmentStatus,
      metadata: attachment.metadata,
      createdAt: row.created_at
    });
  }

  async findById(id: number): Promise<MessageAttachment | null> {
    const query = `
      SELECT id, message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata, created_at
      FROM public.message_attachments
      WHERE id = $1;
    `;

    const result = await this.pool.query(query, [id]);
    if (result.rows.length === 0) return null;

    return this.mapRowToEntity(result.rows[0]);
  }

  async findByMessageId(messageId: number): Promise<MessageAttachment[]> {
    const query = `
      SELECT id, message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata, created_at
      FROM public.message_attachments
      WHERE message_id = $1
      ORDER BY id ASC;
    `;

    const result = await this.pool.query(query, [messageId]);
    return result.rows.map(row => this.mapRowToEntity(row));
  }

  async findByStorageKey(storageKey: string): Promise<MessageAttachment | null> {
    const query = `
      SELECT id, message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata, created_at
      FROM public.message_attachments
      WHERE storage_key = $1;
    `;

    const result = await this.pool.query(query, [storageKey]);
    if (result.rows.length === 0) return null;

    return this.mapRowToEntity(result.rows[0]);
  }

  async updateStatus(id: number, status: AttachmentStatus, metadata?: Record<string, any>): Promise<void> {
    const query = `
      UPDATE public.message_attachments
      SET 
        attachment_status = $2,
        metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
      WHERE id = $1;
    `;

    await this.pool.query(query, [id, status, JSON.stringify(metadata || {})]);
  }

  async delete(id: number): Promise<void> {
    const query = `DELETE FROM public.message_attachments WHERE id = $1;`;
    await this.pool.query(query, [id]);
  }

  private mapRowToEntity(row: any): MessageAttachment {
    return new MessageAttachment({
      id: row.id,
      messageId: row.message_id,
      fileUrl: row.file_url,
      thumbnailUrl: row.thumbnail_url || undefined,
      fileName: row.file_name,
      fileType: row.file_type || "application/octet-stream",
      fileSize: row.file_size || 0,
      storageKey: row.storage_key || "",
      attachmentStatus: row.attachment_status || "READY",
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}),
      createdAt: row.created_at
    });
  }
}
