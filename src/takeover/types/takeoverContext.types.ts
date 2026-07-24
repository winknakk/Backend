import { MessageAttachment } from "../../domain/entities/MessageAttachment";

export interface HumanTakeoverContextPackage {
  conversationId: number;
  ticketId: string;
  customerProfile: {
    identityId: number | string;
    displayName: string;
    primaryChannel: string;
  };
  conversationHistory: Array<{
    id: number;
    role: string;
    content: string;
    messageType: string;
    attachments: MessageAttachment[];
    createdAt: Date;
  }>;
  aiSummary: {
    lastIntentDetected?: string;
    whyEscalatedReason?: string;
    suggestedReply?: string;
  };
}

export interface OperatorReplyOptions {
  conversationId: number;
  operatorId: number;
  textContent: string;
  attachments?: {
    storageKey?: string;
    fileUrl: string;
    fileName: string;
    fileType: string;
    fileSize: number;
  }[];
}
