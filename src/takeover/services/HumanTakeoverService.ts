import { IMessageAttachmentRepository } from "../../domain/repositories/IMessageAttachmentRepository";
import { HumanTakeoverContextPackage, OperatorReplyOptions } from "../types/takeoverContext.types";
import { MessageAttachment } from "../../domain/entities/MessageAttachment";
import { Pool } from "pg";

export class HumanTakeoverService {
  constructor(
    private pool: Pool,
    private attachmentRepository: IMessageAttachmentRepository
  ) {}

  async assembleTakeoverContext(conversationId: number): Promise<HumanTakeoverContextPackage> {
    // 1. Fetch conversation messages
    const msgQuery = `
      SELECT id, conversation_id, role, content, message_type, ticket_id, created_at
      FROM public.messages
      WHERE conversation_id = $1
      ORDER BY id ASC;
    `;
    const msgResult = await this.pool.query(msgQuery, [conversationId]);
    const rows = msgResult.rows;

    const conversationHistory: HumanTakeoverContextPackage["conversationHistory"] = [];

    // 2. Hydrate each message with its attachments
    for (const row of rows) {
      const attachments = await this.attachmentRepository.findByMessageId(row.id);
      conversationHistory.push({
        id: row.id,
        role: row.role,
        content: row.content,
        messageType: row.message_type || "text",
        attachments,
        createdAt: row.created_at
      });
    }

    return {
      conversationId,
      ticketId: rows[0]?.ticket_id ? String(rows[0].ticket_id) : "N/A",
      customerProfile: {
        identityId: conversationId,
        displayName: "Customer",
        primaryChannel: "line"
      },
      conversationHistory,
      aiSummary: {
        lastIntentDetected: "Payment Inquiry",
        whyEscalatedReason: "Operator Takeover Lease Requested",
        suggestedReply: "ได้รับสลิปแล้วครับ ดำเนินการตรวจสอบให้เรียบร้อยแล้วครับ"
      }
    };
  }

  async sendOperatorReply(options: OperatorReplyOptions): Promise<{ messageId: number; attachments: MessageAttachment[] }> {
    // 1. Insert Operator Message into DB
    const insertMsgQuery = `
      INSERT INTO public.messages (conversation_id, role, content, message_type, message_purpose, created_at)
      VALUES ($1, 'operator', $2, $3, 'reply', NOW())
      RETURNING id;
    `;
    const msgType = options.attachments && options.attachments.length > 0 ? "image" : "text";
    const msgResult = await this.pool.query(insertMsgQuery, [options.conversationId, options.textContent, msgType]);
    const messageId = msgResult.rows[0].id;

    // 2. Save Operator Attachments
    const createdAttachments: MessageAttachment[] = [];
    if (options.attachments && options.attachments.length > 0) {
      for (const att of options.attachments) {
        const attachmentEntity = new MessageAttachment({
          messageId,
          fileUrl: att.fileUrl,
          fileName: att.fileName,
          fileType: att.fileType,
          fileSize: att.fileSize,
          storageKey: att.storageKey || "",
          attachmentStatus: "READY",
          metadata: { senderRole: "operator", operatorId: options.operatorId }
        });
        const saved = await this.attachmentRepository.create(attachmentEntity);
        createdAttachments.push(saved);
      }
    }

    return { messageId, attachments: createdAttachments };
  }
}
