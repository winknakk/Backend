import { InboundMessage, OutboundMessage } from "../schemas/validation";
import { IMemoryService } from "../memory/types";
import { AgentManager } from "../agent/AgentRuntime";
import { createLogger } from "../observability/logger";
import { startTimer } from "../observability/timing";
import { randomUUID } from "crypto";
import { TakeoverManager } from "../human-takeover/TakeoverManager";

const logger = createLogger("Orchestrator");

export class Orchestrator {
  public memoryService: IMemoryService;
  public agentManager: AgentManager;
  public takeoverManager: TakeoverManager;

  constructor(memoryService: IMemoryService, agentManager: AgentManager, takeoverManager = new TakeoverManager()) {
    this.memoryService = memoryService;
    this.agentManager = agentManager;
    this.takeoverManager = takeoverManager;
  }

  /**
   * Accepts raw inbound message, loads memory, runs the Agent, and yields outbound message.
   */
  async handleIncomingMessage(message: InboundMessage, requestId?: string): Promise<OutboundMessage> {
    const reqId = requestId || randomUUID();
    const timer = startTimer();

    logger.info(
      { requestId: reqId, senderId: message.senderId, channel: message.channel, component: "Orchestrator" },
      `Intake Webhook: From ${message.senderId} | Channel ${message.channel}`
    );

    try {
      // Ensure local conversation and identity exist first for the customer
      await this.memoryService.ensureConversation(message.senderId, "1", message.channel);

      // 1. Hydrate memory and load session context
      const sessionContext = await this.memoryService.loadSessionContext(message.senderId, message.channel);

      logger.info(
        {
          requestId: reqId,
          conversationId: sessionContext.conversationId,
          companyId: sessionContext.companyId,
          component: "Orchestrator",
        },
        `Hydrated session context for company ID: ${sessionContext.companyId}`
      );

      // Check Human Takeover State
      const takeoverState = await this.takeoverManager.getTakeoverState(sessionContext.conversationId);
      
      // If human session expired, switch handled_by back to AI in DB
      if (takeoverState.status === "ACTIVE_AI" && sessionContext.handledBy === "human") {
        logger.info(
          {
            requestId: reqId,
            conversationId: sessionContext.conversationId,
            component: "Orchestrator",
          },
          "Human session expired. Switching database handoff state back to 'ai'."
        );
        await this.memoryService.updateHandoffState(sessionContext.conversationId, "ai");
        sessionContext.handledBy = "ai";
      }

      if (takeoverState.status === "PENDING_HUMAN" || takeoverState.status === "ACTIVE_HUMAN") {
        logger.info(
          {
            requestId: reqId,
            conversationId: sessionContext.conversationId,
            status: takeoverState.status,
            component: "Orchestrator",
          },
          "Human takeover active: bypassing AgentRuntime reasoning loop."
        );

        await this.memoryService.appendConversationLog(sessionContext.conversationId, "customer", message.text);

        const durationMs = timer();
        return {
          recipientId: message.senderId,
          channel: message.channel,
          text: `Message flagged for human support. (AI Muted - Room Status: ${takeoverState.status})`,
          sentAt: new Date().toISOString(),
        };
      }

      // 2. Resolve Agent session
      const agentSession = await this.agentManager.getOrCreateSession(message.senderId, sessionContext.companyId);

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
