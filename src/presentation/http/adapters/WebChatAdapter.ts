import { IMediaStorageService } from "../../../media/services/IMediaStorageService";
import { INormalizedMessage, MessageType } from "../../../normalizer/types/normalizedMessage.types";
import { MessageAttachment } from "../../../domain/entities/MessageAttachment";

export interface WebChatPayloadOptions {
  sessionToken: string;
  identityId: string;
  externalMessageId?: string;
  messageType?: MessageType;
  text?: string;
  fileBuffer?: Buffer;
  fileName?: string;
  mimeType?: string;
}

export class WebChatAdapter {
  constructor(private mediaStorageService: IMediaStorageService) {}

  async adaptPayload(options: WebChatPayloadOptions): Promise<INormalizedMessage> {
    const channelRef = options.identityId || "webchat_guest";
    const externalMessageId = options.externalMessageId || `wc_msg_${Date.now()}`;
    const receivedAt = new Date();

    let messageType: MessageType = options.messageType || "text";
    let textContent = options.text || "";
    const attachments: MessageAttachment[] = [];

    // Check if direct binary file payload was uploaded via WebChat multipart
    if (options.fileBuffer && options.fileName && options.mimeType) {
      messageType = options.mimeType.startsWith("image/") ? "image" : "file";

      // Upload binary stream directly to Object Storage via MediaStorageService
      const uploadResult = await this.mediaStorageService.upload({
        buffer: options.fileBuffer,
        fileName: options.fileName,
        mimeType: options.mimeType,
        folder: "webchat_media"
      });

      // Build MessageAttachment Aggregate
      const attachment = new MessageAttachment({
        messageId: 0, // Assigned upon database message insert
        fileUrl: uploadResult.fileUrl,
        fileName: uploadResult.fileName,
        fileType: uploadResult.fileType,
        fileSize: uploadResult.fileSize,
        storageKey: uploadResult.storageKey,
        attachmentStatus: "READY",
        metadata: {
          sourceChannel: "webchat",
          sessionToken: options.sessionToken
        }
      });

      attachments.push(attachment);
    }

    return {
      channelType: "webchat",
      channelRef,
      externalMessageId,
      messageType,
      textContent,
      attachments,
      receivedAt,
      rawPayload: {
        sessionToken: options.sessionToken,
        identityId: options.identityId,
        fileName: options.fileName,
        mimeType: options.mimeType
      }
    };
  }
}
