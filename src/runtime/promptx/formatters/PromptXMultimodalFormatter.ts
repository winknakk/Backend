import { INormalizedMessage } from "../../../normalizer/types/normalizedMessage.types";
import { MessageAttachment } from "../../../domain/entities/MessageAttachment";

export interface PromptXMultimodalContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export interface PromptXFormattedPayload {
  role: 'user' | 'assistant' | 'system';
  content: string | PromptXMultimodalContentPart[];
  metadata: {
    hasImage: boolean;
    attachmentCount: number;
    attachmentIds: (number | string)[];
  };
}

export class PromptXMultimodalFormatter {
  static formatMessage(message: INormalizedMessage): PromptXFormattedPayload {
    const hasImage = message.messageType === 'image' && message.attachments.length > 0;

    if (!hasImage) {
      return {
        role: 'user',
        content: message.textContent || '',
        metadata: {
          hasImage: false,
          attachmentCount: 0,
          attachmentIds: []
        }
      };
    }

    // Build multimodal content array (Text + Presigned CDN Image URLs)
    const contentParts: PromptXMultimodalContentPart[] = [];

    // 1. Add text caption or default contextual text
    const caption = message.textContent?.trim();
    contentParts.push({
      type: 'text',
      text: caption && caption.length > 0 
        ? caption 
        : "Customer provided an image attachment."
    });

    // 2. Add presigned CDN image URLs (NO Base64!)
    const attachmentIds: (number | string)[] = [];
    for (const attachment of message.attachments) {
      if (attachment.fileType.startsWith("image/") || attachment.fileUrl) {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: attachment.fileUrl,
            detail: 'auto'
          }
        });
        attachmentIds.push(attachment.id || attachment.storageKey);
      }
    }

    return {
      role: 'user',
      content: contentParts,
      metadata: {
        hasImage: true,
        attachmentCount: message.attachments.length,
        attachmentIds
      }
    };
  }
}
