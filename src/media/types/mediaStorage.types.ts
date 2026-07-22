export interface UploadMediaOptions {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  folder?: string;
}

export interface UploadMediaResult {
  storageKey: string;
  fileUrl: string;
  fileName: string;
  fileType: string;
  fileSize: number;
}

export interface PresignedUrlOptions {
  storageKey: string;
  expiresInSeconds?: number;
}
