import axios from "axios";
import { config } from "../config/env";
import { CircuitBreaker } from "./CircuitBreaker";

export interface PromptXChatResponse {
  type: "tool_call" | "final";
  tool?: string;
  arguments?: Record<string, any>;
  text: string;
}

export class PromptXMcpClient {
  private url: string;
  private token: string;
  public static circuitBreaker = new CircuitBreaker();

  constructor() {
    this.url = config.PROMPTX_MCP_URL;
    this.token = config.PROMPTX_MCP_TOKEN;
  }

  /**
   * Helper that establishes an SSE GET connection, extracts the POST URL endpoint,
   * sends a JSON-RPC request to that POST URL, waits for the response on the SSE stream,
   * and cleans up all connections afterwards.
   */
  private parseSseResponse(text: string, requestId: number): any {
    const lines = text.split("\n");
    let currentEvent = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.substring(6).trim();
      } else if (line.startsWith("data:")) {
        const dataVal = line.substring(5).trim();

        if (currentEvent === "message") {
          try {
            const parsed = JSON.parse(dataVal);
            if (parsed.id === requestId) {
              if (parsed.error) {
                throw new Error(`PromptX MCP Server Error: ${parsed.error.message} (Code: ${parsed.error.code})`);
              }
              return parsed.result;
            }
          } catch (err: any) {
            if (err.message && err.message.startsWith("PromptX MCP Server Error")) {
              throw err;
            }
          }
        }
      }
    }

    // Fallback: direct JSON parse
    try {
      const parsed = JSON.parse(text);
      if (parsed.id === requestId) {
        if (parsed.error) {
          throw new Error(`PromptX MCP Server Error: ${parsed.error.message} (Code: ${parsed.error.code})`);
        }
        return parsed.result;
      }
    } catch (err: any) {
      if (err.message && err.message.startsWith("PromptX MCP Server Error")) {
        throw err;
      }
    }

    throw new Error("No valid JSON-RPC response found in HTTP POST response.");
  }

  private async executeJsonRpc(method: string, params: Record<string, any>, timeoutMs: number = 20000, context?: any): Promise<any> {
    return PromptXMcpClient.circuitBreaker.execute(async () => {
      if (!this.url || !this.token) {
        throw new Error("PROMPTX_MCP_URL or PROMPTX_MCP_TOKEN environment variable is not defined.");
      }

      const requestId = Math.floor(100000 + Math.random() * 900000);
      const payload = {
        jsonrpc: "2.0",
        id: requestId,
        method,
        params,
      };

      console.log(`[PromptXMcpClient] Sending JSON-RPC POST to '${this.url}' for method '${method}' (RequestId: ${requestId})`);
      console.log(`[PromptXMcpClient] Token length: ${this.token?.length}`);

      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };

      if (context?.correlationId) {
        headers["x-correlation-id"] = context.correlationId;
      }
      if (context?.traceId) {
        headers["x-trace-id"] = context.traceId;
      }

      const res = await axios.post(this.url, payload, {
        headers,
        timeout: timeoutMs,
        responseType: "text",
      });

      return this.parseSseResponse(res.data, requestId);
    });
  }

  /**
   * Calls the PromptX MCP Chat agent with message, conversation context, tenant context, and available tools.
   */
  async chatAgent(
    message: string,
    conversationContext: { conversationId: string; history: Array<{ role: string; content: string }> },
    tenantContext: { companyId: string; companyName: string },
    availableTools: Array<{ name: string; description: string }>
  ): Promise<PromptXChatResponse> {
    const response = await this.executeJsonRpc("tools/call", {
      name: "chat",
      arguments: {
        message,
        conversationContext,
        tenantContext,
        availableTools,
      },
    });

    const textContent = response.content?.[0]?.text;
    if (typeof textContent !== "string") {
      throw new Error("PromptX MCP response format error: expected text inside content array.");
    }

    try {
      // Attempt to parse the text content as tool call JSON
      const parsed = JSON.parse(textContent);
      if (parsed && typeof parsed === "object" && typeof parsed.tool === "string") {
        return {
          type: "tool_call",
          tool: parsed.tool,
          arguments: parsed.arguments || {},
          text: textContent,
        };
      }
    } catch (e) {
      // Not JSON, treat as regular final response
    }

    return {
      type: "final",
      text: textContent,
    };
  }

  /**
   * Discovers all available tools on the remote PromptX MCP Server.
   */
  async listTools(): Promise<any[]> {
    const response = await this.executeJsonRpc("tools/list", {});
    return response.tools || [];
  }

  /**
   * Calls a remote tool on the PromptX MCP Server.
   */
  async callTool(name: string, args: Record<string, any>, context?: any): Promise<any> {
    const response = await this.executeJsonRpc(
      "tools/call",
      {
        name,
        arguments: args,
      },
      20000,
      context
    );
    return response;
  }
}
