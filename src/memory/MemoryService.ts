import { IMemoryService, SessionContext } from "./types";
import { AgentMessage } from "../agent/types";
import { DatabaseAdapter } from "../adapters/types";

export class MemoryService implements IMemoryService {
  private dbAdapter: DatabaseAdapter;

  constructor(dbAdapter: DatabaseAdapter) {
    this.dbAdapter = dbAdapter;
  }

  async loadSessionContext(senderId: string, channel: string): Promise<SessionContext> {
    return await this.dbAdapter.loadSessionContext(senderId, channel);
  }

  async getConversationHistory(conversationId: string, limit: number = 10): Promise<AgentMessage[]> {
    const list = await this.dbAdapter.getConversationHistory(conversationId, limit);
    return list.map((m) => ({
      role: m.role as "customer" | "ai" | "system",
      content: m.content || "",
      timestamp: m.timestamp || new Date().toISOString(),
    }));
  }

  async appendConversationLog(
    conversationId: string,
    role: "customer" | "ai" | "system",
    message: string,
    externalId?: string
  ): Promise<void> {
    await this.dbAdapter.saveMessage(conversationId, role, message, externalId);
  }

  async ensureConversation(senderId: string, companyId: string, channel: string): Promise<string> {
    return await this.dbAdapter.ensureConversation(senderId, companyId, channel);
  }

  async updateHandoffState(conversationId: string, handledBy: "ai" | "human"): Promise<void> {
    await this.dbAdapter.updateHandoffState(conversationId, handledBy);
  }

  async getFullConversationHistory(conversationId: string): Promise<Array<{ id: string; role: string; content: string; timestamp: string }>> {
    // Use getMessagesWithIds if available, otherwise fall back to getMessages
    if ('getMessagesWithIds' in this.dbAdapter && typeof (this.dbAdapter as any).getMessagesWithIds === 'function') {
      return (this.dbAdapter as any).getMessagesWithIds(conversationId);
    }
    // Fallback: getMessages without Ids (memory tracking will use array-order Ids)
    const msgs = await this.dbAdapter.getMessages(conversationId);
    return msgs.map((m: any, idx: number) => ({
      id: String(m.id || idx),
      role: m.role || "customer",
      content: m.content || "",
      timestamp: m.timestamp || m.created_at || new Date().toISOString(),
    }));
  }
}
