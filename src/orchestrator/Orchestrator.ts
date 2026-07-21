import { InboundMessage, OutboundMessage } from "../schemas/validation";
import { IMemoryService } from "../memory/types";
import { AgentManager } from "../agent/AgentRuntime";
import { createLogger } from "../observability/logger";
import { startTimer } from "../observability/timing";
import { randomUUID } from "crypto";
import { TakeoverManager } from "../human-takeover/TakeoverManager";
import { ConversationResolver } from "../conversation/ConversationResolver";
import { IssueSessionBuilder } from "../runtime/IssueSessionBuilder";
import { IssueSessionResolver } from "../runtime/IssueSessionResolver";
import { LifecycleState } from "../runtime/IssueSession";
import { RuntimeContextResolver } from "../services/RuntimeContextResolver";

const logger = createLogger("Orchestrator");

export class Orchestrator {
  public memoryService: IMemoryService;
  public agentManager: AgentManager;
  public takeoverManager: TakeoverManager;
  public conversationResolver: ConversationResolver;

  constructor(
    memoryService: IMemoryService,
    agentManager: AgentManager,
    takeoverManager = new TakeoverManager(),
    conversationResolver = new ConversationResolver()
  ) {
    this.memoryService = memoryService;
    this.agentManager = agentManager;
    this.takeoverManager = takeoverManager;
    this.conversationResolver = conversationResolver;
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
      const conversationId = sessionContext.conversationId;

      logger.info(
        {
          requestId: reqId,
          conversationId,
          companyId: sessionContext.companyId,
          component: "Orchestrator",
        },
        `Hydrated session context for company ID: ${sessionContext.companyId}`
      );

      // Resolve database adapter and project context to build IssueSession
      const dbAdapter = (this.memoryService as any).dbAdapter;
      const contextResolver = new RuntimeContextResolver(dbAdapter);
      const runtimeContext = await contextResolver.resolveRuntimeContext(conversationId);
      if (!runtimeContext) {
        throw new Error(`Failed to resolve RuntimeContext for conversation ${conversationId}`);
      }

      const activeTicket = await dbAdapter.getLatestTicketForConversation(conversationId);

      const conversationState = {
        id: runtimeContext.conversationId,
        status: sessionContext.status as any,
        handledBy: sessionContext.handledBy,
        channel: runtimeContext.channel
      };

      const ticketState = {
        id: activeTicket?.id,
        ticketCode: activeTicket?.ticket_id,
        status: activeTicket?.status,
        priority: activeTicket?.priority,
        slaBreached: activeTicket?.sla_breached || false
      };

      const session = new IssueSessionBuilder()
        .withSessionId(reqId)
        .withContext(runtimeContext)
        .withConversation(conversationState)
        .withTicket(ticketState)
        .build();

      session.transitionTo(LifecycleState.HYDRATING);
      session.transitionTo(LifecycleState.READY);

      return await IssueSessionResolver.run(session, async () => {
        session.transitionTo(LifecycleState.PROCESSING);

        // Check Human Takeover State
        const takeoverState = await this.takeoverManager.getTakeoverState(conversationId);
        const isHumanHandoffActive = takeoverState.status === "PENDING_HUMAN" || takeoverState.status === "ACTIVE_HUMAN" || sessionContext.handledBy === "human";

        // Verify active participant status & group mentions (only if human handoff is NOT active)
        if (!isHumanHandoffActive) {
          const resolution = await this.conversationResolver.shouldProcess(message, conversationId);
          if (!resolution.shouldProcess) {
            const durationMs = timer();
            logger.info(
              { requestId: reqId, conversationId, reason: resolution.reason, component: "Orchestrator" },
              "Group conversation message ignored (not mentioned and no active participant session)"
            );
            session.transitionTo(LifecycleState.RESPONDING);
            session.transitionTo(LifecycleState.COMPLETED);
            return {
              recipientId: message.senderId,
              channel: message.channel,
              text: `Muted: ${resolution.reason}`,
              sentAt: new Date().toISOString(),
            };
          }
        }
        
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
          session.conversation = { ...session.conversation, handledBy: "ai" };
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

          await this.memoryService.appendConversationLog(
            sessionContext.conversationId,
            "customer",
            message.text,
            message.externalId
          );

          const durationMs = timer();
          session.transitionTo(LifecycleState.RESPONDING);
          session.transitionTo(LifecycleState.COMPLETED);
          return {
            recipientId: message.senderId,
            channel: message.channel,
            text: `Message flagged for human support. (AI Muted - Room Status: ${takeoverState.status})`,
            sentAt: new Date().toISOString(),
          };
        }

        // 2. Resolve Agent session
        const agentSession = await this.agentManager.getOrCreateSession(message.senderId, sessionContext.companyId, message.channel);

        // 3. Trigger Agent reasoning and tool loop
        const reply = await agentSession.chat(message, reqId);

        session.transitionTo(LifecycleState.RESPONDING);
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

        session.transitionTo(LifecycleState.COMPLETED);
        return reply;
      });
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
