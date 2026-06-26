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
  private async executeJsonRpc(method: string, params: Record<string, any>, timeoutMs: number = 20000): Promise<any> {
    return PromptXMcpClient.circuitBreaker.execute(async () => {
      if (!this.url || !this.token) {
        throw new Error("PROMPTX_MCP_URL or PROMPTX_MCP_TOKEN environment variable is not defined.");
      }

      console.log(`[PromptXMcpClient] Connecting to SSE at '${this.url}'`);
      console.log(`[PromptXMcpClient] Token length: ${this.token?.length}, value: '${this.token}'`);

      // 1. Establish SSE GET request
      const sseResponse = await axios.get(this.url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "text/event-stream",
        },
        responseType: "stream",
        timeout: timeoutMs,
      });

      return new Promise((resolve, reject) => {
        let postUrl = "";
        const requestId = Math.floor(100000 + Math.random() * 900000);
        let timeoutId: NodeJS.Timeout;

        const cleanup = () => {
          clearTimeout(timeoutId);
          sseResponse.data.destroy();
        };

        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error(`Timeout waiting for JSON-RPC response for method '${method}' (RequestId: ${requestId})`));
        }, timeoutMs);

        sseResponse.data.on("data", async (chunk: Buffer) => {
          const lines = chunk.toString().split("\n");
          let currentEvent = "";

          for (const line of lines) {
            if (line.startsWith("event:")) {
              currentEvent = line.substring(6).trim();
            } else if (line.startsWith("data:")) {
              const dataVal = line.substring(5).trim();

              if (currentEvent === "endpoint") {
                postUrl = dataVal;
                console.log(`[PromptXMcpClient] Dynamic endpoint received: ${postUrl}`);

                // 2. Send the POST JSON-RPC request to the dynamic endpoint
                try {
                  const payload = {
                    jsonrpc: "2.0",
                    id: requestId,
                    method,
                    params,
                  };

                  await axios.post(postUrl, payload, {
                    headers: {
                      Authorization: `Bearer ${this.token}`,
                      "Content-Type": "application/json",
                    },
                    timeout: timeoutMs,
                  });
                } catch (postErr: any) {
                  cleanup();
                  reject(new Error(`Failed to POST request to dynamic endpoint: ${postErr.message}`));
                }
              } else if (currentEvent === "message") {
                try {
                  const parsed = JSON.parse(dataVal);
                  if (parsed.id === requestId) {
                    cleanup();
                    if (parsed.error) {
                      reject(
                        new Error(`PromptX MCP Server Error: ${parsed.error.message} (Code: ${parsed.error.code})`)
                      );
                    } else {
                      resolve(parsed.result);
                    }
                  }
                } catch (err) {
                  // Ignore parsing errors for non-JSON lines or heartbeats
                }
              }
            }
          }
        });

        sseResponse.data.on("error", (err: any) => {
          cleanup();
          reject(err);
        });

        sseResponse.data.on("end", () => {
          cleanup();
          reject(new Error("SSE stream closed unexpectedly without returning response."));
        });
      });
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
  async callTool(name: string, args: Record<string, any>): Promise<any> {
    const response = await this.executeJsonRpc("tools/call", {
      name,
      arguments: args,
    });
    return response;
  }
}
