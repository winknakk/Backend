import { AgentResult, IAgent } from "./types";
import { InboundMessage } from "../../schemas/validation";
import { IMcpToolRouter } from "../AgentRuntime";
import { createLogger } from "../../observability/logger";
import { startTimer } from "../../observability/timing";
import { MetricsService } from "../../observability/MetricsService";

const logger = createLogger("KnowledgeAgent");

export class KnowledgeAgent implements IAgent {
  readonly id = "knowledge";
  readonly name = "Knowledge Agent";
  private mcpToolRouter: IMcpToolRouter;

  constructor(mcpToolRouter: IMcpToolRouter) {
    this.mcpToolRouter = mcpToolRouter;
  }

  async handle(message: InboundMessage, sessionContext: any): Promise<AgentResult> {
    MetricsService.getInstance().recordAgentCall("knowledge");

    const reqId = sessionContext.requestId;
    const conversationId = sessionContext.conversationId;

    logger.info(
      { requestId: reqId, conversationId, component: "KnowledgeAgent" },
      "Knowledge Agent searching project docs"
    );

    const timer = startTimer();
    const searchResult = await this.mcpToolRouter.callTool(
      "search_project_docs",
      { query: message.text },
      sessionContext
    );

    logger.info(
      {
        requestId: reqId,
        conversationId,
        durationMs: timer(),
        component: "KnowledgeAgent",
        success: searchResult.success
      },
      "Knowledge Agent search completed"
    );

    if (searchResult.success && searchResult.data?.results) {
      const bestMatch = searchResult.data.results[0];
      const isSourceTrusted = (src: string) =>
        ["local", "nocodb", "nocodb_mock", "nocodb_live", "postgres", "vector_store"].includes(src.toLowerCase());

      if (bestMatch && bestMatch.confidence >= 0.8 && isSourceTrusted(bestMatch.source)) {
        logger.info(
          { requestId: reqId, conversationId, component: "KnowledgeAgent" },
          "High confidence solution found"
        );

        return {
          text: `I found a matching knowledge-base answer for "${message.text}":\n\n${bestMatch.content}`
        };
      }
    }

    logger.info(
      { requestId: reqId, conversationId, component: "KnowledgeAgent" },
      "No high confidence solution found, requesting handoff to ticket agent"
    );

    return {
      text: "",
      handoffTo: "ticket",
      handoffReason: "No high confidence knowledge base answer was found.",
      handoffContext: {
        searchedTool: "search_project_docs",
        query: message.text,
        confidenceThreshold: 0.8
      }
    };
  }
}
