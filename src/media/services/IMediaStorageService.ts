import { UploadMediaOptions, UploadMediaResult } from "../types/mediaStorage.types";

export interface IMediaStorageService {
  upload(options: UploadMediaOptions): Promise<UploadMediaResult>;
  download(storageKey: string): Promise<{ buffer: Buffer; mimeType: string }>;
  generatePresignedUrl(storageKey: string, expiresInSeconds?: number): Promise<string>;
  delete(storageKey: string): Promise<void>;
}
