import { BaseEntity } from "../../shared/domain/BaseEntity";

export type AttachmentStatus = 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED' | 'DELETED';

export interface AttachmentMetadata {
  dimensions?: { width: number; height: number };
  durationSeconds?: number;
  stickerId?: string;
  packageId?: string;
  latitude?: number;
  longitude?: number;
  ocrResult?: { text: string; confidence: number };
  visionResult?: { detectedType: string; description: string; confidence: number };
  [key: string]: any;
}

export interface MessageAttachmentProps {
  id?: number;
  messageId: number;
  fileUrl: string;
  thumbnailUrl?: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  storageKey: string;
  attachmentStatus?: AttachmentStatus;
  metadata?: AttachmentMetadata;
  createdAt?: Date;
}

export class MessageAttachment extends BaseEntity<number> {
  public readonly messageId: number;
  public readonly fileUrl: string;
  public readonly thumbnailUrl?: string;
  public readonly fileName: string;
  public readonly fileType: string;
  public readonly fileSize: number;
  public readonly storageKey: string;
  public attachmentStatus: AttachmentStatus;
  public metadata: AttachmentMetadata;
  public readonly createdAt: Date;

  constructor(props: MessageAttachmentProps) {
    super(props.id || 0);

    if (!props.messageId) throw new Error("Message ID is required for attachment");
    if (!props.fileUrl) throw new Error("File URL is required for attachment");
    if (!props.fileName) throw new Error("File Name is required for attachment");

    this.messageId = props.messageId;
    this.fileUrl = props.fileUrl;
    this.thumbnailUrl = props.thumbnailUrl;
    this.fileName = props.fileName;
    this.fileType = props.fileType || "application/octet-stream";
    this.fileSize = props.fileSize || 0;
    this.storageKey = props.storageKey || "";
    this.attachmentStatus = props.attachmentStatus || "READY";
    this.metadata = props.metadata || {};
    this.createdAt = props.createdAt || new Date();
  }

  public markAsReady(fileUrl: string, thumbnailUrl?: string): void {
    this.attachmentStatus = 'READY';
    (this as any).fileUrl = fileUrl;
    if (thumbnailUrl) {
      (this as any).thumbnailUrl = thumbnailUrl;
    }
  }

  public markAsFailed(reason: string): void {
    this.attachmentStatus = 'FAILED';
    this.metadata = { ...this.metadata, errorReason: reason };
  }
}
