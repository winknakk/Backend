import { IAgentRouter, IAgent } from "./types";
import { InboundMessage } from "../../schemas/validation";
import { PromptXMcpClient } from "../../mcp/PromptXMcpClient";
import { createLogger } from "../../observability/logger";
import { MetricsService } from "../../observability/MetricsService";

const logger = createLogger("SupervisorAgent");

export class SupervisorAgent implements IAgentRouter {
  private agents = new Map<string, IAgent>();
  private promptXMcpClient = new PromptXMcpClient();

  registerAgent(agent: IAgent): void {
    this.agents.set(agent.id, agent);
    logger.info({ agentId: agent.id, agentName: agent.name }, "Registered agent in supervisor router");
  }

  getAgent(id: string): IAgent | null {
    return this.agents.get(id) || null;
  }

  listAgents(): IAgent[] {
    return Array.from(this.agents.values());
  }

  async route(message: InboundMessage, sessionContext: any): Promise<IAgent> {
    const reqId = sessionContext.requestId;
    const conversationId = sessionContext.conversationId;

    logger.info(
      { requestId: reqId, conversationId, component: "SupervisorAgent" },
      `Routing message: "${message.text}"`
    );

    let decision = "support";

    if (process.env.NODE_ENV === "test") {
      decision = this.fallbackClassify(message.text);
      logger.info(
        { requestId: reqId, conversationId, decision, component: "SupervisorAgent" },
        `Routing decision: resolved agent target is "${decision}"`
      );
      MetricsService.getInstance().recordRoutingDecision(decision);
      const testAgent = this.agents.get(decision) || this.agents.get("support");
      if (!testAgent) {
        throw new Error(`Critical routing error: default "support" agent is not registered.`);
      }
      return testAgent;
    }

    const classificationPrompt = `You are a supervisor agent routing messages. Classify the user message into one of the following agent targets:
- "ticket" (if they explicitly request to open a ticket, create a ticket, or file a complaint)
- "knowledge" (if they are asking how to do something, reporting a technical issue, login issue, expired session, or SSO issue that can be answered from a manual/guide/knowledge base)
- "support" (general conversation, greeting, chit-chat, or anything else)

Respond with ONLY the name of the target agent ("ticket", "knowledge", or "support") in the format:
{
  "agent": "ticket" | "knowledge" | "support"
}`;

    try {
      const result = await this.promptXMcpClient.chatAgent(
        `Classify this message: "${message.text}"\n\nInstructions:\n${classificationPrompt}`,
        {
          conversationId,
          history: sessionContext.history || [],
        },
        {
          companyId: sessionContext.companyId,
          companyName: sessionContext.companyContext?.companyName || "Default Company",
        },
        []
      );

      const text = result.text.trim().toLowerCase();
      if (text.includes("ticket")) {
        decision = "ticket";
      } else if (text.includes("knowledge")) {
        decision = "knowledge";
      } else if (text.includes("support")) {
        decision = "support";
      } else {
        try {
          const parsed = JSON.parse(text);
          if (
            parsed &&
            typeof parsed === "object" &&
            (parsed.agent === "ticket" || parsed.agent === "knowledge" || parsed.agent === "support")
          ) {
            decision = parsed.agent;
          } else {
            decision = this.fallbackClassify(message.text);
          }
        } catch {
          decision = this.fallbackClassify(message.text);
        }
      }
    } catch (err: any) {
      logger.warn(
        { requestId: reqId, conversationId, error: err.message, component: "SupervisorAgent" },
        "PromptX classification failed, using fallback keyword classifier"
      );
      decision = this.fallbackClassify(message.text);
    }

    logger.info(
      { requestId: reqId, conversationId, decision, component: "SupervisorAgent" },
      `Routing decision: resolved agent target is "${decision}"`
    );

    MetricsService.getInstance().recordRoutingDecision(decision);

    const agent = this.agents.get(decision) || this.agents.get("support");
    if (!agent) {
      throw new Error(`Critical routing error: default "support" agent is not registered.`);
    }

    return agent;
  }

  private fallbackClassify(text: string): string {
    const lowerText = text.toLowerCase();

    // Ticket keywords
    if (lowerText.includes("ตั๋ว") || lowerText.includes("ticket") || lowerText.includes("เปิดเรื่อง")) {
      return "ticket";
    }

    // Knowledge keywords
    if (
      lowerText.includes("คู่มือ") ||
      lowerText.includes("login") ||
      lowerText.includes("expired") ||
      lowerText.includes("sso")
    ) {
      return "knowledge";
    }

    return "support";
  }
}
