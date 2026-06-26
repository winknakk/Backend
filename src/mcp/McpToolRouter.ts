import { IMcpToolRouter } from "../agent/AgentRuntime";
import { IPolicyEngine } from "../policy/types";
import { IExecutionTraceService } from "../execution/types";
import { IToolRegistry } from "../tools/types";
import { ExecutionResult } from "../schemas/validation";
import { createLogger } from "../observability/logger";
import { startTimer } from "../observability/timing";
import { MetricsService } from "../observability/MetricsService";

const logger = createLogger("McpToolRouter");

export class McpToolRouter implements IMcpToolRouter {
  private policyEngine: IPolicyEngine;
  private executionTraceService: IExecutionTraceService;
  private toolRegistry: IToolRegistry;

  constructor(policyEngine: IPolicyEngine, executionTraceService: IExecutionTraceService, toolRegistry: IToolRegistry) {
    this.policyEngine = policyEngine;
    this.executionTraceService = executionTraceService;
    this.toolRegistry = toolRegistry;
  }

  async callTool(toolName: string, params: Record<string, any>, sessionContext: any): Promise<ExecutionResult> {
    MetricsService.getInstance().recordToolCall(toolName);
    const timer = startTimer();
    const policyContext = {
      companyId: sessionContext.companyId,
      sessionId: sessionContext.sessionId,
      userRole: "customer",
    };
    const agentId = sessionContext.activeAgentId || "unknown-agent";

    // 1. Authorize Tool Call through Policy Engine
    const authResponse = await this.policyEngine.authorizeToolCall(toolName, params, policyContext);

    if (!authResponse.isAllowed) {
      const reason = authResponse.reason || "Rejected by Policy Engine";
      const denyTraceId = await this.executionTraceService.startTrace({
        sessionId: sessionContext.sessionId,
        agentId,
        toolName,
        reason,
        arguments: {
          agentId,
          toolName,
          reason,
          params,
        },
        requestId: sessionContext.requestId,
        conversationId: sessionContext.conversationId,
        parentTraceId: sessionContext.parentTraceId,
      });
      await this.executionTraceService.failTrace(denyTraceId, reason);

      logger.warn(
        {
          requestId: sessionContext.requestId,
          conversationId: sessionContext.conversationId,
          traceId: denyTraceId,
          agentId,
          toolName,
          reason,
          component: "McpToolRouter",
          durationMs: timer(),
        },
        `Tool call '${toolName}' rejected by policy. Reason: ${reason}`
      );
      return {
        success: false,
        data: null,
        error: reason,
        source: "policy_engine",
        executionId: denyTraceId,
      };
    }

    // 2. Start Execution Trace Logging
    const actualTraceId = await this.executionTraceService.startTrace({
      sessionId: sessionContext.sessionId,
      agentId,
      toolName,
      reason: "Agent requested tool call during conversation reasoning.",
      arguments: authResponse.sanitizedParams || params,
      requestId: sessionContext.requestId,
      conversationId: sessionContext.conversationId,
      parentTraceId: sessionContext.parentTraceId,
    });

    try {
      // 3. Execute Tool
      const tool = this.toolRegistry.getTool(toolName);
      if (!tool) {
        throw new Error(`Tool '${toolName}' not found in registry.`);
      }

      logger.info(
        {
          requestId: sessionContext.requestId,
          conversationId: sessionContext.conversationId,
          traceId: actualTraceId,
          component: "McpToolRouter",
        },
        `Running tool '${toolName}'`
      );

      const result = await tool.execute(authResponse.sanitizedParams || params);

      // 4. Complete Execution Trace
      await this.executionTraceService.completeTrace(actualTraceId, result);

      const isExecutionResult = result && typeof result === "object" && "success" in result && "data" in result;
      const finalResult = {
        success: isExecutionResult ? result.success : true,
        data: isExecutionResult ? result.data : result,
        error: isExecutionResult ? result.error : null,
        source: isExecutionResult ? result.source : "local",
        executionId: isExecutionResult && result.executionId ? result.executionId : actualTraceId,
      };

      const durationMs = timer();
      logger.info(
        {
          requestId: sessionContext.requestId,
          conversationId: sessionContext.conversationId,
          traceId: actualTraceId,
          durationMs,
          component: "McpToolRouter",
          success: finalResult.success,
        },
        `Tool '${toolName}' execution succeeded`
      );

      return finalResult;
    } catch (e: any) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      const durationMs = timer();

      logger.error(
        {
          requestId: sessionContext.requestId,
          conversationId: sessionContext.conversationId,
          traceId: actualTraceId,
          durationMs,
          component: "McpToolRouter",
          error: errorMsg,
        },
        `Tool '${toolName}' execution failed`
      );

      // 5. Fail Execution Trace
      await this.executionTraceService.failTrace(actualTraceId, errorMsg);

      return {
        success: false,
        data: null,
        error: errorMsg,
        source: "execution_engine",
        executionId: actualTraceId,
      };
    }
  }
}
