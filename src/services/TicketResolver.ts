import { DatabaseAdapter } from "../adapters/types";
import { createLogger } from "../observability/logger";
import { randomUUID } from "crypto";
import { RuntimeContextResolver } from "./RuntimeContextResolver";

const logger = createLogger("TicketResolver");

export class TicketResolver {
  constructor(private dbAdapter: DatabaseAdapter) {}

  /**
   * Resolves the active ticket for a given conversation.
   */
  async resolveActiveTicket(conversationId: string): Promise<any | null> {
    return await this.dbAdapter.getLatestTicketForConversation(conversationId);
  }

  /**
   * Performs Just-In-Time (JIT) ticket creation when escalated or requested.
   */
  async createJitTicket(
    conversationId: string,
    companyId: string,
    subject: string,
    senderId: string
  ): Promise<any> {
    logger.info({ conversationId, companyId, subject }, "Initiating JIT Ticket Escalation");

    // 1. Resolve Project ID from Conversation Context using RuntimeContextResolver
    let projectId: string | undefined;
    try {
      const contextResolver = new RuntimeContextResolver(this.dbAdapter);
      const context = await contextResolver.resolveRuntimeContext(conversationId);
      if (context && context.projectId) {
        projectId = String(context.projectId);
      }
    } catch (err: any) {
      logger.warn({ conversationId, error: err.message }, "Could not load project_id from RuntimeContextResolver");
    }

    // 2. Fallback: If conversation has no project_id, resolve from company projects
    if (!projectId) {
      try {
        const sessionContext = await this.dbAdapter.loadSessionContext(senderId, "line_group");
        if (sessionContext?.companyContext?.projects?.length > 0) {
          projectId = sessionContext.companyContext.projects[0].projectId;
        }
      } catch (err: any) {
        logger.warn({ conversationId, error: err.message }, "Could not load projects for company context");
      }
    }

    // 2. Generate a unique ticket number
    const ticketNumber = `TCK-${new Date().getFullYear()}-${Math.floor(10000 + Math.random() * 90000)}`;

    const ticketInput = {
      conversationId,
      subject: subject || `IT support requested: LINE Group issue from ${senderId}`,
      summary: `Automated JIT Ticket escalation for conversation ${conversationId} on channel line_group`,
      priority: "P2" as const,
      severity: "Medium" as const,
      projectId: projectId || "1",
    };

    // Calculate due date (e.g. 24 hours from now)
    const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const result = await this.dbAdapter.createTicket(ticketInput, dueDate, ticketNumber);
    if (!result.success) {
      throw new Error(`Failed to create JIT ticket: ${result.error}`);
    }

    logger.info({ conversationId, ticketNumber, ticketId: result.data.id }, "Successfully created JIT Ticket");
    return result.data;
  }
}
