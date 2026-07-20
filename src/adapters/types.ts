import { TicketInput, ExecutionResult, AuditLog } from "../schemas/validation";
import { SessionContext } from "../memory/types";

export interface DatabaseAdapter {
  /**
   * Creates a ticket record in the database provider.
   */
  createTicket(input: TicketInput, slaDueDate: string, ticketNumber: string): Promise<ExecutionResult>;

  /**
   * Finds a project by its unique ID.
   */
  findProject(projectId: string): Promise<any>;

  /**
   * Retrieves a conversation by its ID.
   */
  getConversation(conversationId: string): Promise<any>;

  /**
   * Saves a message log to the conversation.
   */
  saveMessage(conversationId: string, role: string, content: string, externalId?: string): Promise<any>;

  /**
   * Finds an active conversation or creates one if it doesn't exist.
   * Returns the conversation ID.
   */
  ensureConversation(senderId: string, companyId: string, channel: string): Promise<string>;

  /**
   * Hydrates the session details (company details, active SLA, etc.) for a sender.
   */
  loadSessionContext(senderId: string, channel: string): Promise<SessionContext>;

  /**
   * Retrieves conversation history messages.
   */
  getConversationHistory(conversationId: string, limit?: number): Promise<any[]>;

  /**
   * Updates conversation PM assignment or handoff status.
   */
  updateHandoffState(conversationId: string, handledBy: "ai" | "human"): Promise<void>;

  /**
   * Performs local/external search query across tickets, messages, or documents.
   * Returns records with matching search content.
   */
  searchKnowledge(query: string, filters?: { projectId?: string }): Promise<any[]>;

  /**
   * Saves an execution trace log.
   */
  saveTrace(trace: AuditLog): Promise<void>;

  /**
   * Retrieves a single trace details by UUID.
   */
  getTrace(traceId: string): Promise<AuditLog | null>;

  /**
   * Lists all execution traces for a specific session.
   */
  listTraces(sessionId: string): Promise<AuditLog[]>;

  /**
   * Lists all execution traces globally.
   */
  listAllTraces(): Promise<AuditLog[]>;

  /**
   * Lists all tickets globally or filtered by conversation and project.
   */
  listAllTickets(conversationId?: string, projectId?: string, profileId?: string, identityId?: string): Promise<any[]>;

  /**
   * Lists all conversations globally or filtered by project.
   */
  listAllConversations(projectId?: string): Promise<any[]>;

  /**
   * Retrieves messages for a specific conversation.
   */
  getMessages(conversationId: string): Promise<any[]>;

  /**
   * Retrieves identity and channel details for a conversation.
   */
  getConversationIdent(conversationId: string): Promise<any>;

  /**
   * Updates plane issue ID and status for a ticket.
   */
  updateTicketPlaneIssue(ticketId: string, planeIssueId: string): Promise<void>;

  /**
   * Applies Plane-originated status/priority changes to a linked ticket.
   * Returns false when no ticket is linked to the supplied Plane issue ID.
   */
  syncTicketFromPlane(
    planeIssueId: string,
    changes: { status?: string; priority?: string }
  ): Promise<boolean>;

  /**
   * Retrieves ticket details along with company context.
   */
  getTicketCompanyContext(ticketId: string): Promise<{ ticket: any; companyName: string }>;
}

