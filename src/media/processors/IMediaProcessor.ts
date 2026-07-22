import { MessageAttachment } from "../../domain/entities/MessageAttachment";

export interface ProcessMediaResult {
  thumbnailUrl?: string;
  metadata: Record<string, any>;
  status: 'READY' | 'FAILED';
}

export interface IMediaProcessor {
  process(attachment: MessageAttachment, buffer: Buffer): Promise<ProcessMediaResult>;
}
