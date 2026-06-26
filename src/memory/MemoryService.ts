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
    message: string
  ): Promise<void> {
    await this.dbAdapter.saveMessage(conversationId, role, message);
  }

  async ensureConversation(senderId: string, companyId: string, channel: string): Promise<string> {
    return await this.dbAdapter.ensureConversation(senderId, companyId, channel);
  }

  async updateHandoffState(conversationId: string, handledBy: "ai" | "human"): Promise<void> {
    await this.dbAdapter.updateHandoffState(conversationId, handledBy);
  }
}
