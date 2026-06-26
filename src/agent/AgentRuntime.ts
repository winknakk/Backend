import { IAgentSession, AgentSessionState } from "./types";
import { InboundMessage, OutboundMessage } from "../schemas/validation";
import { IMemoryService } from "../memory/types";
import { IPolicyEngine } from "../policy/types";
import { randomUUID } from "crypto";
import { createLogger } from "../observability/logger";
import { startTimer } from "../observability/timing";
import { SupervisorAgent } from "./supervisor/SupervisorAgent";
import { SupportAgent } from "./supervisor/SupportAgent";
import { KnowledgeAgent } from "./supervisor/KnowledgeAgent";
import { TicketAgent } from "./supervisor/TicketAgent";
import { AgentResult, IAgent, IAgentRouter } from "./supervisor/types";
import { config } from "../config/env";

import { IExecutionTraceService } from "../execution/types";

const logger = createLogger("AgentRuntime");

export interface IMcpToolRouter {
  callTool(toolName: string, params: Record<string, any>, sessionContext: any): Promise<any>;
}

export class AgentRuntime implements IAgentSession {
  readonly sessionId: string;
  private companyId: string;
  private memoryService: IMemoryService;
  private mcpToolRouter: IMcpToolRouter;
  private policyEngine: IPolicyEngine;
  private traceService?: IExecutionTraceService;
  private status: "ACTIVE" | "HUMAN_HANDOFF" | "COMPLETED" = "ACTIVE";
  private agentRouter: IAgentRouter;
  private maxHandoffDepth: number;

  constructor(
    sessionId: string,
    companyId: string,
    memoryService: IMemoryService,
    mcpToolRouter: IMcpToolRouter,
    policyEngine: IPolicyEngine,
    traceService?: IExecutionTraceService
  ) {
    this.sessionId = sessionId;
    this.companyId = companyId;
    this.memoryService = memoryService;
    this.mcpToolRouter = mcpToolRouter;
    this.policyEngine = policyEngine;
    this.traceService = traceService;
    this.maxHandoffDepth = config.MAX_AGENT_HANDOFF_DEPTH;

    const supervisor = new SupervisorAgent();
    supervisor.registerAgent(new SupportAgent());
    supervisor.registerAgent(new KnowledgeAgent(this.mcpToolRouter));
    supervisor.registerAgent(new TicketAgent(this.mcpToolRouter));
    this.agentRouter = supervisor;
  }

  async chat(message: InboundMessage, requestId?: string): Promise<OutboundMessage> {
    const reqId = requestId || randomUUID();
    const timer = startTimer();

    // 1. Sanitize incoming input
    const sanitizedInput = await this.policyEngine.sanitizeInputText(message.text);

    // 2. Load context and ensure conversation
    const conversationId = await this.memoryService.ensureConversation(
      message.senderId,
      this.companyId,
      message.channel
    );
    const sessionContext = await this.memoryService.loadSessionContext(message.senderId, message.channel);
    const companyName = sessionContext.companyContext?.companyName || "Default Company";

    logger.info({ requestId: reqId, conversationId, component: "AgentRuntime" }, "Start chat processing");

    // Append customer log
    await this.memoryService.appendConversationLog(conversationId, "customer", sanitizedInput);

    // Get current message history from DB
    const history = await this.memoryService.getConversationHistory(conversationId);
    const historyForAgent = history.map((h) => ({
      role: h.role as string,
      content: h.content as string,
    }));

    // 3. Knowledge-Aware Agentic Decision Flow
    logger.debug({ requestId: reqId, conversationId, component: "AgentRuntime" }, "Start PromptX reasoning loop");

    const richSessionContext = {
      ...sessionContext,
      history: historyForAgent,
      requestId: reqId,
      companyId: this.companyId,
      companyName,
      conversationId,
      sessionId: this.sessionId,
      parentTraceId: reqId,
    };

    const sanitizedMessage = { ...message, text: sanitizedInput };

    // Route and execute through a bounded handoff loop owned by the runtime.
    const reply = await this.runHandoffLoop(sanitizedMessage, richSessionContext);

    // 5. Log AI response
    await this.memoryService.appendConversationLog(conversationId, "ai", reply.text);

    // 6. Sanitize outgoing response
    const sanitizedOutput = await this.policyEngine.sanitizeOutputText(reply.text);

    const durationMs = timer();
    logger.info(
      { requestId: reqId, conversationId, durationMs, component: "AgentRuntime" },
      "Chat processing completed"
    );

    return {
      recipientId: message.senderId,
      channel: message.channel,
      text: sanitizedOutput,
      sentAt: new Date().toISOString(),
    };
  }

  private async runHandoffLoop(message: InboundMessage, sessionContext: any): Promise<AgentResult> {
    const history = ["supervisor"];
    const visitedAgents = new Set<string>();
    let agent = await this.agentRouter.route(message, {
      ...sessionContext,
      handoffHistory: history,
    });

    for (let depth = 0; depth < this.maxHandoffDepth; depth += 1) {
      if (visitedAgents.has(agent.id)) {
        const reason = `Agent handoff loop detected at '${agent.id}'.`;
        logger.warn(
          {
            requestId: sessionContext.requestId,
            conversationId: sessionContext.conversationId,
            agentId: agent.id,
            handoffHistory: history,
            component: "AgentRuntime",
          },
          reason
        );
        await this.memoryService.appendConversationLog(sessionContext.conversationId, "system", reason);
        return {
          text: "I could not safely continue agent routing because a handoff loop was detected.",
          handoffHistory: history,
        };
      }

      visitedAgents.add(agent.id);
      history.push(agent.id);

      logger.info(
        {
          requestId: sessionContext.requestId,
          conversationId: sessionContext.conversationId,
          agentId: agent.id,
          handoffHistory: history,
          component: "AgentRuntime",
        },
        "Executing routed agent"
      );

      const result = await agent.handle(message, {
        ...sessionContext,
        activeAgentId: agent.id,
        handoffHistory: history,
      });
      result.handoffHistory = [...history];

      if (!result.handoffTo) {
        return result;
      }

      const nextAgent = this.agentRouter.getAgent(result.handoffTo);
      const reason = result.handoffReason || `Agent '${agent.id}' requested handoff to '${result.handoffTo}'.`;

      if (this.traceService) {
        try {
          const traceId = await this.traceService.startTrace({
            sessionId: sessionContext.sessionId,
            agentId: agent.id,
            toolName: `handoff_to_${result.handoffTo}`,
            reason,
            arguments: {
              fromAgentId: agent.id,
              toAgentId: result.handoffTo,
              handoffHistory: history,
              handoffContext: result.handoffContext,
            },
            requestId: sessionContext.requestId,
            conversationId: sessionContext.conversationId,
            parentTraceId: sessionContext.parentTraceId,
          });
          await this.traceService.handoffTrace(traceId, {
            fromAgentId: agent.id,
            toAgentId: result.handoffTo,
            handoffHistory: history,
          });
        } catch (e: any) {
          logger.warn({ error: e.message }, "Failed to write handoff trace log.");
        }
      }

      logger.info(
        {
          requestId: sessionContext.requestId,
          conversationId: sessionContext.conversationId,
          fromAgentId: agent.id,
          toAgentId: result.handoffTo,
          reason,
          handoffContext: result.handoffContext,
          handoffHistory: history,
          component: "AgentRuntime",
        },
        "Agent handoff requested"
      );

      await this.memoryService.appendConversationLog(
        sessionContext.conversationId,
        "system",
        `Agent handoff: ${agent.id} -> ${result.handoffTo}. Reason: ${reason}`
      );

      if (!nextAgent) {
        logger.warn(
          {
            requestId: sessionContext.requestId,
            conversationId: sessionContext.conversationId,
            requestedAgentId: result.handoffTo,
            component: "AgentRuntime",
          },
          "Requested handoff target is not registered"
        );
        return {
          text: `I could not hand off to '${result.handoffTo}' because that agent is not registered.`,
          handoffHistory: history,
        };
      }

      agent = nextAgent;
    }

    const reason = `Maximum agent handoff depth exceeded (${this.maxHandoffDepth}).`;
    logger.warn(
      {
        requestId: sessionContext.requestId,
        conversationId: sessionContext.conversationId,
        maxHandoffDepth: this.maxHandoffDepth,
        handoffHistory: history,
        component: "AgentRuntime",
      },
      reason
    );
    await this.memoryService.appendConversationLog(sessionContext.conversationId, "system", reason);

    return {
      text: "I could not safely continue agent routing because the handoff limit was reached.",
      handoffHistory: history,
    };
  }

  async getState(): Promise<AgentSessionState> {
    const conversationId = this.sessionId.replace("sess_", "");
    const history = await this.memoryService.getConversationHistory(conversationId);
    return {
      sessionId: this.sessionId,
      companyId: this.companyId,
      history,
      status: this.status,
    };
  }

  async triggerHandoff(reason: string): Promise<void> {
    this.status = "HUMAN_HANDOFF";
    const conversationId = this.sessionId.replace("sess_", "");
    await this.memoryService.updateHandoffState(conversationId, "human");
    await this.memoryService.appendConversationLog(conversationId, "system", `Handoff triggered: ${reason}`);
  }
}

export class AgentManager {
  private memoryService: IMemoryService;
  private mcpToolRouter: IMcpToolRouter;
  private policyEngine: IPolicyEngine;
  private traceService?: IExecutionTraceService;
  private activeSessions: Record<string, AgentRuntime> = {};
  public agentRouter: IAgentRouter;

  constructor(
    memoryService: IMemoryService,
    mcpToolRouter: IMcpToolRouter,
    policyEngine: IPolicyEngine,
    traceService?: IExecutionTraceService
  ) {
    this.memoryService = memoryService;
    this.mcpToolRouter = mcpToolRouter;
    this.policyEngine = policyEngine;
    this.traceService = traceService;

    const supervisor = new SupervisorAgent();
    supervisor.registerAgent(new SupportAgent());
    supervisor.registerAgent(new KnowledgeAgent(mcpToolRouter));
    supervisor.registerAgent(new TicketAgent(mcpToolRouter));
    this.agentRouter = supervisor;
  }

  async getOrCreateSession(senderId: string, companyId: string): Promise<AgentRuntime> {
    const conversationId = await this.memoryService.ensureConversation(senderId, companyId, "LINE");
    const sessionId = `sess_${conversationId}`;

    if (!this.activeSessions[sessionId]) {
      this.activeSessions[sessionId] = new AgentRuntime(
        sessionId,
        companyId,
        this.memoryService,
        this.mcpToolRouter,
        this.policyEngine,
        this.traceService
      );
    }
    return this.activeSessions[sessionId];
  }

  async closeSession(sessionId: string): Promise<void> {
    delete this.activeSessions[sessionId];
  }
}
