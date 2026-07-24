import { MessageAttachment, AttachmentStatus } from "../entities/MessageAttachment";

export interface IMessageAttachmentRepository {
  create(attachment: MessageAttachment): Promise<MessageAttachment>;
  findById(id: number): Promise<MessageAttachment | null>;
  findByMessageId(messageId: number): Promise<MessageAttachment[]>;
  findByStorageKey(storageKey: string): Promise<MessageAttachment | null>;
  updateStatus(id: number, status: AttachmentStatus, metadata?: Record<string, any>): Promise<void>;
  delete(id: number): Promise<void>;
}
