import { IMediaStorageService } from "../../../media/services/IMediaStorageService";
import { INormalizedMessage, MessageType } from "../../../normalizer/types/normalizedMessage.types";
import { MessageAttachment } from "../../../domain/entities/MessageAttachment";
import axios from "axios";

export class LINEAdapter {
  constructor(
    private mediaStorageService: IMediaStorageService,
    private lineChannelAccessToken?: string
  ) {}

  async adaptEvent(event: any): Promise<INormalizedMessage | null> {
    if (event.type !== "message") return null;

    const lineMsg = event.message;
    const channelRef = event.source?.userId || event.source?.groupId || "unknown_line_user";
    const externalMessageId = lineMsg.id;
    const receivedAt = new Date(event.timestamp || Date.now());

    let messageType: MessageType = "text";
    let textContent = "";
    const attachments: MessageAttachment[] = [];

    switch (lineMsg.type) {
      case "text":
        messageType = "text";
        textContent = lineMsg.text || "";
        break;

      case "image":
        messageType = "image";
        textContent = lineMsg.text || ""; // Captions if any

        // Step 1: Download LINE Image Binary using LINE Content API
        const { buffer, mimeType } = await this.downloadLINEContent(externalMessageId);

        // Step 2: Upload to Object Storage via MediaStorageService
        const uploadResult = await this.mediaStorageService.upload({
          buffer,
          fileName: `line_img_${externalMessageId}.jpg`,
          mimeType,
          folder: "line_media"
        });

        // Step 3: Build MessageAttachment Aggregate
        const attachment = new MessageAttachment({
          messageId: 0, // Assigned upon database message insert
          fileUrl: uploadResult.fileUrl,
          fileName: uploadResult.fileName,
          fileType: uploadResult.fileType,
          fileSize: uploadResult.fileSize,
          storageKey: uploadResult.storageKey,
          attachmentStatus: "READY",
          metadata: {
            sourceChannel: "line",
            lineMessageId: externalMessageId
          }
        });

        attachments.push(attachment);
        break;

      case "sticker":
        messageType = "sticker";
        textContent = "";
        const stickerAttachment = new MessageAttachment({
          messageId: 0,
          fileUrl: `https://stickershop.line-scdn.net/stickershop/v1/sticker/${lineMsg.stickerId}/android/sticker.png`,
          fileName: `sticker_${lineMsg.stickerId}.png`,
          fileType: "image/png",
          fileSize: 0,
          storageKey: `stickers/${lineMsg.packageId}/${lineMsg.stickerId}`,
          attachmentStatus: "READY",
          metadata: {
            packageId: lineMsg.packageId,
            stickerId: lineMsg.stickerId
          }
        });
        attachments.push(stickerAttachment);
        break;

      default:
        messageType = "text";
        textContent = lineMsg.text || `[Unsupported LINE message type: ${lineMsg.type}]`;
        break;
    }

    return {
      channelType: "line",
      channelRef,
      externalMessageId,
      messageType,
      textContent,
      attachments,
      receivedAt,
      rawPayload: event
    };
  }

  private async downloadLINEContent(messageId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const token = this.lineChannelAccessToken || process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!token) {
      throw new Error("LINE Channel Access Token is not configured");
    }

    const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`
      },
      responseType: "arraybuffer"
    });

    const mimeType = String(response.headers["content-type"] || "image/jpeg");
    const buffer = Buffer.from(response.data);

    return { buffer, mimeType };
  }
}
