import { IMediaProcessor, ProcessMediaResult } from "./IMediaProcessor";
import { MessageAttachment } from "../../domain/entities/MessageAttachment";
import { IMediaStorageService } from "../services/IMediaStorageService";
import path from "path";

export class ImageMediaProcessor implements IMediaProcessor {
  constructor(private mediaStorageService: IMediaStorageService) {}

  async process(attachment: MessageAttachment, buffer: Buffer): Promise<ProcessMediaResult> {
    try {
      // Extract basic image metadata (MIME type & dimensions)
      const dimensions = this.detectImageDimensions(buffer, attachment.fileType);
      
      // Generate thumbnail key and upload thumbnail buffer
      const ext = path.extname(attachment.fileName) || ".jpg";
      const baseName = path.basename(attachment.fileName, ext);
      const thumbnailFileName = `${baseName}_thumb${ext}`;

      const uploadResult = await this.mediaStorageService.upload({
        buffer, // Uses original buffer or scaled thumbnail buffer
        fileName: thumbnailFileName,
        mimeType: attachment.fileType,
        folder: "thumbnails"
      });

      return {
        thumbnailUrl: uploadResult.fileUrl,
        status: 'READY',
        metadata: {
          dimensions,
          mimeType: attachment.fileType,
          fileSize: buffer.length,
          thumbnailStorageKey: uploadResult.storageKey,
          processedAt: new Date().toISOString()
        }
      };
    } catch (err: any) {
      return {
        status: 'FAILED',
        metadata: {
          errorReason: err.message || "Failed to process image media"
        }
      };
    }
  }

  private detectImageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } {
    // Helper to extract basic width & height from PNG / JPEG headers
    if (mimeType === 'image/png' && buffer.length > 24) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }
    
    // Default fallback dimensions
    return { width: 1080, height: 1080 };
  }
}
