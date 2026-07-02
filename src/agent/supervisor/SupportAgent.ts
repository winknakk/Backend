import { AgentResult, IAgent } from "./types";
import { InboundMessage } from "../../schemas/validation";
import { PromptXMcpClient } from "../../mcp/PromptXMcpClient";
import { createLogger } from "../../observability/logger";
import { startTimer } from "../../observability/timing";
import { MetricsService } from "../../observability/MetricsService";

const logger = createLogger("SupportAgent");

export class SupportAgent implements IAgent {
  readonly id = "support";
  readonly name = "Support Agent";
  private promptXMcpClient = new PromptXMcpClient();

  async handle(message: InboundMessage, sessionContext: any): Promise<AgentResult> {
    MetricsService.getInstance().recordAgentCall("support");

    const reqId = sessionContext.requestId;
    const conversationId = sessionContext.conversationId;
    const companyName = sessionContext.companyContext?.companyName || "Default Company";

    logger.info({ requestId: reqId, conversationId, component: "SupportAgent" }, "Support Agent handling message");

    const timer = startTimer();

    try {
      // Build history with memory context layering: SYSTEM (memory) → RECENT → CURRENT
      const recentHistory: Array<{ role: string; content: string }> = sessionContext.history || [];
      const historyWithMemory: Array<{ role: string; content: string }> = [];

      // Prepend memory as system-role advisory context
      if (sessionContext.memory) {
        historyWithMemory.push({
          role: "system",
          content: sessionContext.memory,
        });
      }

      // Append recent messages
      historyWithMemory.push(...recentHistory);

      const response = await this.promptXMcpClient.chatAgent(
        message.text,
        {
          conversationId,
          history: historyWithMemory,
        },
        {
          companyId: sessionContext.companyId,
          companyName,
        },
        []
      );

      logger.info(
        { requestId: reqId, conversationId, durationMs: timer(), component: "SupportAgent" },
        "Support Agent finished handling message"
      );

      return { text: response.text };
    } catch (error: any) {
      logger.error(
        { requestId: reqId, conversationId, error: error.message, component: "SupportAgent" },
        "Support Agent failed to handle message. Activating Local Emergency Fallback Runtime."
      );
      return {
        text: "Hello, I am currently running in emergency fallback mode because the upstream server is unavailable. How can I help you? (Local Emergency Fallback)",
      };
    }
  }
}
