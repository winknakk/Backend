import { AgentResult, IAgent } from "./types";
import { InboundMessage } from "../../schemas/validation";
import { IMcpToolRouter } from "../AgentRuntime";
import { createLogger } from "../../observability/logger";
import { startTimer } from "../../observability/timing";
import { MetricsService } from "../../observability/MetricsService";

const logger = createLogger("TicketAgent");

export class TicketAgent implements IAgent {
  readonly id = "ticket";
  readonly name = "Ticket Agent";
  private mcpToolRouter: IMcpToolRouter;

  constructor(mcpToolRouter: IMcpToolRouter) {
    this.mcpToolRouter = mcpToolRouter;
  }

  async handle(message: InboundMessage, sessionContext: any): Promise<AgentResult> {
    MetricsService.getInstance().recordAgentCall("ticket");

    const reqId = sessionContext.requestId;
    const conversationId = sessionContext.conversationId;

    logger.info({ requestId: reqId, conversationId, component: "TicketAgent" }, "Ticket Agent creating support ticket");

    const timer = startTimer();
    const ticketResult = await this.mcpToolRouter.callTool(
      "create_ticket",
      {
        conversationId,
        subject: `IT support requested: ${message.text.slice(0, 30)}...`,
        summary: `User reported issue: "${message.text}" on channel ${message.channel}`,
        priority: "P2",
        severity: "High",
        projectId: "p1",
      },
      sessionContext
    );

    logger.info(
      {
        requestId: reqId,
        conversationId,
        durationMs: timer(),
        component: "TicketAgent",
        success: ticketResult.success,
      },
      "Ticket Agent ticket creation completed"
    );

    if (!ticketResult.success) {
      return {
        text: `I could not create the support ticket because the tool call failed: ${ticketResult.error}`,
      };
    }

    const ticket = ticketResult.data;
    return {
      text: `I created support ticket ${ticket.ticketId}. The support team can now follow up on this issue.`,
    };
  }
}
