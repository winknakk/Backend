import { IMediaStorageService } from "./IMediaStorageService";
import { UploadMediaOptions, UploadMediaResult } from "../types/mediaStorage.types";
import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface S3Config {
  endpoint?: string;
  bucketName?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  localVaultPath?: string;
  publicCdnBaseUrl?: string;
}

export class S3MediaStorageService implements IMediaStorageService {
  private bucketName: string;
  private localVaultPath: string;
  private publicCdnBaseUrl: string;

  constructor(config: S3Config) {
    this.bucketName = config.bucketName || "automationx-media";
    this.localVaultPath = config.localVaultPath || path.join(process.cwd(), "uploads");
    this.publicCdnBaseUrl = config.publicCdnBaseUrl || "http://localhost:3000/api/v1/media";

    if (!fs.existsSync(this.localVaultPath)) {
      fs.mkdirSync(this.localVaultPath, { recursive: true });
    }
  }

  async upload(options: UploadMediaOptions): Promise<UploadMediaResult> {
    const fileHash = crypto.createHash("md5").update(options.buffer).digest("hex").slice(0, 10);
    const datePrefix = new Date().toISOString().slice(0, 7).replace("-", "/"); // e.g. 2026/07
    const ext = path.extname(options.fileName) || this.getExtensionFromMime(options.mimeType);
    const safeName = path.basename(options.fileName, ext).replace(/[^a-zA-Z0-9_-]/g, "_");
    
    const folder = options.folder || datePrefix;
    const storageKey = `${folder}/${safeName}_${fileHash}${ext}`;

    const fullPath = path.join(this.localVaultPath, storageKey);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await fs.promises.writeFile(fullPath, options.buffer);

    const fileUrl = await this.generatePresignedUrl(storageKey, 900);

    return {
      storageKey,
      fileUrl,
      fileName: options.fileName,
      fileType: options.mimeType,
      fileSize: options.buffer.length
    };
  }

  async download(storageKey: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const fullPath = path.join(this.localVaultPath, storageKey);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Media file not found for key: ${storageKey}`);
    }

    const buffer = await fs.promises.readFile(fullPath);
    const ext = path.extname(storageKey).toLowerCase();
    let mimeType = this.getMimeFromExtension(ext);
    if (buffer.toString("utf-8", 0, 50).includes("<svg")) {
      mimeType = "image/svg+xml";
    }

    return { buffer, mimeType };
  }


  async generatePresignedUrl(storageKey: string, expiresInSeconds: number = 900): Promise<string> {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const token = crypto
      .createHmac("sha256", process.env.JWT_SECRET || "automationx_secret")
      .update(`${storageKey}:${expiresAt}`)
      .digest("hex");

    return `${this.publicCdnBaseUrl}/file?key=${encodeURIComponent(storageKey)}&expires=${expiresAt}&signature=${token}`;
  }

  async delete(storageKey: string): Promise<void> {
    const fullPath = path.join(this.localVaultPath, storageKey);
    if (fs.existsSync(fullPath)) {
      await fs.promises.unlink(fullPath);
    }
  }

  private getExtensionFromMime(mimeType: string): string {
    switch (mimeType) {
      case "image/jpeg": return ".jpg";
      case "image/png": return ".png";
      case "image/webp": return ".webp";
      case "application/pdf": return ".pdf";
      case "audio/mpeg": return ".mp3";
      case "audio/wav": return ".wav";
      default: return ".bin";
    }
  }

  private getMimeFromExtension(ext: string): string {
    switch (ext) {
      case ".jpg":
      case ".jpeg": return "image/jpeg";
      case ".png": return "image/png";
      case ".webp": return "image/webp";
      case ".pdf": return "application/pdf";
      case ".mp3": return "audio/mpeg";
      case ".wav": return "audio/wav";
      default: return "application/octet-stream";
    }
  }
}
