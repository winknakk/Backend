import { z } from "zod";
import { InboundMessage, OutboundMessage } from "../schemas/validation";

export const AgentMessageRoleSchema = z.enum(["customer", "ai", "system"]);
export type AgentMessageRole = z.infer<typeof AgentMessageRoleSchema>;

export const AgentMessageSchema = z.object({
  role: AgentMessageRoleSchema,
  content: z.string(),
  timestamp: z.string().datetime(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const AgentSessionStateSchema = z.object({
  sessionId: z.string(),
  companyId: z.string(),
  history: z.array(AgentMessageSchema),
  currentTopic: z.string().optional(),
  status: z.enum(["ACTIVE", "HUMAN_HANDOFF", "COMPLETED"]),
});
export type AgentSessionState = z.infer<typeof AgentSessionStateSchema>;

export interface IAgentSession {
  /**
   * Uniquely identifies this conversation session
   */
  readonly sessionId: string;

  /**
   * Processes an incoming message, runs the reasoning loop, invokes tools via MCP, and returns the response.
   */
  chat(message: InboundMessage, requestId?: string): Promise<OutboundMessage>;

  /**
   * Retrieves the current conversation memory state, history, and status.
   */
  getState(): Promise<AgentSessionState>;

  /**
   * Forces handoff to a human operator, changing session status.
   */
  triggerHandoff(reason: string): Promise<void>;
}

export interface IAgentManager {
  /**
   * Retrieves an existing session or initializes a new one for a given customer.
   */
  getOrCreateSession(senderId: string, companyId: string): Promise<IAgentSession>;

  /**
   * Force closes a session, archiving state to database.
   */
  closeSession(sessionId: string): Promise<void>;
}
