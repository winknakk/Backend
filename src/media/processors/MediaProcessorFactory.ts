import { IMediaProcessor } from "./IMediaProcessor";
import { ImageMediaProcessor } from "./ImageMediaProcessor";
import { IMediaStorageService } from "../services/IMediaStorageService";

export class MediaProcessorFactory {
  constructor(private mediaStorageService: IMediaStorageService) {}

  getProcessor(mimeType: string): IMediaProcessor {
    if (mimeType.startsWith("image/")) {
      return new ImageMediaProcessor(this.mediaStorageService);
    }
    
    // Default fallback processor for general documents/files
    return {
      process: async (attachment, buffer) => ({
        status: 'READY',
        metadata: {
          mimeType,
          fileSize: buffer.length,
          processedAt: new Date().toISOString()
        }
      })
    };
  }
}
