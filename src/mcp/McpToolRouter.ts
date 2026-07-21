import { z } from "zod";
import { IMcpToolRouter } from "../agent/AgentRuntime";
import { IPolicyEngine } from "../policy/types";
import { IExecutionTraceService } from "../execution/types";
import { IToolRegistry } from "../tools/types";
import { ExecutionResult } from "../schemas/validation";
import { createLogger } from "../observability/logger";
import { startTimer } from "../observability/timing";
import { MetricsService } from "../observability/MetricsService";
import { IssueSessionResolver } from "../runtime/IssueSessionResolver";

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

    // 0. Enforce local capability-based IssueSession flags checks
    const activeSession = IssueSessionResolver.current();
    if (activeSession) {
      if (!activeSession.canExecuteTool(toolName)) {
        const reason = `Tool execution blocked by active IssueSession flags (state: ${activeSession.state}, allowToolExecution: ${activeSession.flags.allowToolExecution})`;
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
          `Tool call '${toolName}' rejected by IssueSession flags. Reason: ${reason}`
        );
        return {
          success: false,
          data: null,
          error: reason,
          source: "policy_engine",
          executionId: denyTraceId,
        };
      }
    }

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

    const tool = this.toolRegistry.getTool(toolName);
    if (!tool) {
      const errorMsg = `Tool '${toolName}' not found in registry.`;
      await this.executionTraceService.failTrace(actualTraceId, errorMsg);
      const mappedError = this.mapError(new Error(errorMsg), sessionContext);
      return {
        success: false,
        data: null,
        error: mappedError,
        source: "execution_engine",
        executionId: actualTraceId,
        errorCode: mappedError.errorCode,
        retryable: mappedError.retryable,
        correlationId: mappedError.correlationId
      };
    }

    const toolContext = {
      requestId: sessionContext.requestId,
      correlationId: sessionContext.correlationId || sessionContext.requestId || "unknown",
      traceId: actualTraceId,
      sessionId: sessionContext.sessionId,
      conversationId: sessionContext.conversationId
    };

    let result: any;
    let success = false;
    let attempts = 0;
    const maxAttempts = 3;
    let lastError: any = null;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        logger.info(
          {
            requestId: sessionContext.requestId,
            conversationId: sessionContext.conversationId,
            traceId: actualTraceId,
            component: "McpToolRouter",
            attempt: attempts,
          },
          `Running tool '${toolName}' (attempt ${attempts}/${maxAttempts})`
        );

        let mappedParams = authResponse.sanitizedParams || params;
        if (tool.definition && tool.definition.inputSchema) {
          mappedParams = this.mapParamsDynamically(mappedParams, tool.definition.inputSchema);
        }

        result = await tool.execute(mappedParams, toolContext);
        result = this.normalizeOutputDynamically(result);
        success = true;
        break;
      } catch (e: any) {
        lastError = e;
        const mapped = this.mapError(e, sessionContext);
        if (!mapped.retryable || attempts >= maxAttempts) {
          break;
        }
        const delay = Math.pow(2, attempts) * 100;
        logger.warn(
          {
            requestId: sessionContext.requestId,
            conversationId: sessionContext.conversationId,
            traceId: actualTraceId,
            component: "McpToolRouter",
            attempt: attempts,
            error: e.message,
          },
          `Tool '${toolName}' failed with retryable error. Retrying in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (success) {
      // 4. Complete Execution Trace
      await this.executionTraceService.completeTrace(actualTraceId, result);

      const isExecutionResult = result && typeof result === "object" && "success" in result && "data" in result;
      let finalError = isExecutionResult ? result.error : null;
      if (isExecutionResult && result.success === false && typeof finalError === "string") {
        finalError = this.mapError(new Error(finalError), sessionContext);
      }

      const finalResult: any = {
        success: isExecutionResult ? result.success : true,
        data: isExecutionResult ? result.data : result,
        error: finalError,
        source: isExecutionResult ? result.source : "local",
        executionId: isExecutionResult && result.executionId ? result.executionId : actualTraceId,
      };

      if (finalResult.success === false && finalResult.error && typeof finalResult.error === "object") {
        finalResult.errorCode = finalResult.error.errorCode;
        finalResult.retryable = finalResult.error.retryable;
        finalResult.correlationId = finalResult.error.correlationId;
      }

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
    } else {
      const errorMsg = lastError instanceof Error ? lastError.message : String(lastError);
      const mappedError = this.mapError(lastError, sessionContext);
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
        `Tool '${toolName}' execution failed after ${attempts} attempts`
      );

      // 5. Fail Execution Trace
      await this.executionTraceService.failTrace(actualTraceId, errorMsg);

      return {
        success: false,
        data: null,
        error: mappedError,
        source: "execution_engine",
        executionId: actualTraceId,
        errorCode: mappedError.errorCode,
        retryable: mappedError.retryable,
        correlationId: mappedError.correlationId
      };
    }
  }

  private mapError(e: any, sessionContext: any): { errorCode: string; message: string; retryable: boolean; correlationId: string } {
    const correlationId = sessionContext?.requestId || sessionContext?.correlationId || "unknown";
    const message = e instanceof Error ? e.message : String(e);

    if (e instanceof z.ZodError || e.name === "ValidationError" || message.includes("validation") || message.includes("must be at least")) {
      return {
        errorCode: "ValidationError",
        message,
        retryable: false,
        correlationId
      };
    }
    if (message.includes("not found") || message.includes("NotFound")) {
      return {
        errorCode: "NotFound",
        message,
        retryable: false,
        correlationId
      };
    }
    if (message.includes("conflict") || message.includes("Conflict") || message.includes("deadlock") || message.includes("duplicate")) {
      return {
        errorCode: "Conflict",
        message,
        retryable: true,
        correlationId
      };
    }
    if (message.includes("timeout") || message.includes("Timeout")) {
      return {
        errorCode: "Timeout",
        message,
        retryable: true,
        correlationId
      };
    }
    if (message.includes("DependencyUnavailable") || message.includes("network") || message.includes("axios") || message.includes("refused")) {
      return {
        errorCode: "DependencyUnavailable",
        message,
        retryable: true,
        correlationId
      };
    }
    
    return {
      errorCode: "InternalError",
      message,
      retryable: false,
      correlationId
    };
  }

  private mapParamsDynamically(inputParams: Record<string, any>, inputSchema: any): Record<string, any> {
    if (!inputSchema || typeof inputSchema !== "object") return inputParams;

    const expectedProperties = inputSchema.properties 
      ? Object.keys(inputSchema.properties) 
      : (inputSchema.type === "object" && typeof inputSchema.properties === "object" 
          ? Object.keys(inputSchema.properties) 
          : []);

    if (expectedProperties.length === 0) return inputParams;

    const normalizedExpectedMap = new Map<string, string>();
    for (const prop of expectedProperties) {
      const normalized = prop.toLowerCase().replace(/_/g, "");
      normalizedExpectedMap.set(normalized, prop);
    }

    const mapped: Record<string, any> = {};
    for (const [key, value] of Object.entries(inputParams)) {
      const keyNormalized = key.toLowerCase().replace(/_/g, "");
      if (normalizedExpectedMap.has(keyNormalized)) {
        const targetKey = normalizedExpectedMap.get(keyNormalized)!;
        mapped[targetKey] = value;
      } else {
        mapped[key] = value;
      }
    }

    return mapped;
  }

  private normalizeOutputDynamically(result: any): any {
    if (!result || typeof result !== "object") {
      return { success: true, data: result, error: null, source: "remote" };
    }

    if ("success" in result && ("data" in result || "error" in result)) {
      return result;
    }

    let success = true;
    let error = null;

    if (result.status === "error" || result.success === false) {
      success = false;
      error = result.error || result.message || "Execution failed";
    }

    return {
      success,
      data: result.data !== undefined ? result.data : result,
      error,
      source: "remote",
    };
  }
}
