/**
 * ConversationMemoryTypes — Structured memory types for conversation summarization.
 */

export interface ConversationMemory {
  conversationId: string;
  version: number;
  lastSummarizedMessageId: string; // NocoDB row Id — stable across pagination
  dailySummary: string;
  customerIntent: string;
  unresolvedIssues: string[];
  importantFacts: string[];
  humanOperatorActions: string[]; // Decisions, troubleshooting, resolutions, ticket refs
  lastUpdatedAt: string; // ISO timestamp
}

export interface ConversationMemoryStore {
  [conversationId: string]: ConversationMemory;
}

export interface MessageWithId {
  id: string; // NocoDB row Id
  role: string;
  content: string;
  timestamp: string;
}

export interface MemoryContext {
  memoryBlock: string | null; // Formatted system prompt string, or null if no memory
  recentMessages: Array<{ role: string; content: string }>;
}
