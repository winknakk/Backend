import { InboundMessage, OutboundMessage } from "../schemas/validation";
import { IMemoryService } from "../memory/types";
import { AgentManager } from "../agent/AgentRuntime";
import { createLogger } from "../observability/logger";
import { startTimer } from "../observability/timing";
import { randomUUID } from "crypto";

const logger = createLogger("Orchestrator");

export class Orchestrator {
  public memoryService: IMemoryService;
  public agentManager: AgentManager;

  constructor(memoryService: IMemoryService, agentManager: AgentManager) {
    this.memoryService = memoryService;
    this.agentManager = agentManager;
  }

  /**
   * Accepts raw inbound message, loads memory, runs the Agent, and yields outbound message.
   */
  async handleIncomingMessage(
    message: InboundMessage,
    requestId?: string
  ): Promise<OutboundMessage> {
    const reqId = requestId || randomUUID();
    const timer = startTimer();
    
    logger.info(
      { requestId: reqId, senderId: message.senderId, channel: message.channel, component: "Orchestrator" },
      `Intake Webhook: From ${message.senderId} | Channel ${message.channel}`
    );

    try {
      // 1. Hydrate memory and load session context
      const sessionContext = await this.memoryService.loadSessionContext(
        message.senderId,
        message.channel
      );
      
      logger.info(
        { requestId: reqId, conversationId: sessionContext.conversationId, companyId: sessionContext.companyId, component: "Orchestrator" },
        `Hydrated session context for company ID: ${sessionContext.companyId}`
      );

      // 2. Resolve Agent session
      const agentSession = await this.agentManager.getOrCreateSession(
        message.senderId,
        sessionContext.companyId
      );

      // 3. Trigger Agent reasoning and tool loop
      const reply = await agentSession.chat(message, reqId);

      const durationMs = timer();
      logger.info(
        {
          requestId: reqId,
          conversationId: sessionContext.conversationId,
          durationMs,
          component: "Orchestrator",
        },
        `Webhook process completed in ${durationMs.toFixed(2)}ms`
      );

      return reply;
    } catch (err: any) {
      const durationMs = timer();
      logger.error(
        {
          requestId: reqId,
          durationMs,
          component: "Orchestrator",
          error: err.message,
        },
        "Failed to handle incoming message"
      );
      throw err;
    }
  }
}
