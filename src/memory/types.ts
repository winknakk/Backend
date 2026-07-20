import { z } from "zod";
import { AgentMessage } from "../agent/types";

// Zod schema definitions for Session Context & Configuration
export const CompanyContextSchema = z.object({
  companyId: z.string(),
  companyName: z.string(),
  status: z.enum(["Active", "Inactive"]),
  aiPromptTemplate: z.string(),
  knowledgeBaseUrl: z.string().optional(),
  projects: z.array(
    z.object({
      projectId: z.string(),
      projectName: z.string(),
      projectType: z.string(),
    })
  ),
  slaConfig: z.array(
    z.object({
      projectId: z.string(),
      severity: z.string(),
      responseTimeHours: z.number(),
      resolveTimeHours: z.number(),
    })
  ),
});
export type CompanyContext = z.infer<typeof CompanyContextSchema>;

export const SessionContextSchema = z.object({
  sessionId: z.string(),
  companyId: z.string(),
  conversationId: z.string(),
  customerRef: z.string(),
  companyContext: CompanyContextSchema,
  status: z.enum(["open", "closed"]),
  handledBy: z.enum(["ai", "human"]),
});
export type SessionContext = z.infer<typeof SessionContextSchema>;

export interface IMemoryService {
  /**
   * Identifies the client and hydrates company details, active SLA configurations, and project contexts.
   */
  loadSessionContext(senderId: string, channel: string): Promise<SessionContext>;

  /**
   * Retrieves the recent agentic conversation logs (formatted history) for an active session.
   */
  getConversationHistory(conversationId: string, limit?: number): Promise<AgentMessage[]>;

  /**
   * Appends a new conversation log (either from the user, AI, or human support) to NocoDB.
   */
  appendConversationLog(conversationId: string, role: "customer" | "ai" | "system", message: string, externalId?: string): Promise<void>;

  /**
   * Creates or returns an active conversation ID for a client.
   */
  ensureConversation(senderId: string, companyId: string, channel: string): Promise<string>;

  /**
   * Updates who currently handles the chat (routes control back and forth).
   */
  updateHandoffState(conversationId: string, handledBy: "ai" | "human"): Promise<void>;

  /**
   * Retrieves the full conversation history with message Ids for memory tracking.
   */
  getFullConversationHistory(conversationId: string): Promise<Array<{ id: string; role: string; content: string; timestamp: string }>>;
}
