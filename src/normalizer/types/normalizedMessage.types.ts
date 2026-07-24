import { MessageAttachment } from "../../domain/entities/MessageAttachment";

export type ChannelType = 'line' | 'webchat' | 'email' | 'whatsapp' | 'teams' | 'slack';
export type MessageType = 'text' | 'image' | 'pdf' | 'audio' | 'video' | 'sticker' | 'file' | 'location';

export interface INormalizedMessage {
  channelType: ChannelType;
  channelRef: string;
  externalMessageId: string;
  messageType: MessageType;
  textContent: string;
  attachments: MessageAttachment[];
  receivedAt: Date;
  rawPayload: Record<string, any>;
  quoteToken?: string;
}
