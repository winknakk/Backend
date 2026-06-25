import { ITool } from "./types";
import { McpToolDefinition } from "../mcp/types";
import { PromptXMcpClient } from "../mcp/PromptXMcpClient";
import { z } from "zod";

export class DynamicMcpTool implements ITool {
  readonly definition: McpToolDefinition;
  readonly inputSchema: z.ZodObject<any>;
  readonly outputSchema: z.ZodObject<any>;
  private client: PromptXMcpClient;

  constructor(
    name: string,
    description: string,
    inputSchema: any,
    client: PromptXMcpClient,
    source?: string,
    version?: string
  ) {
    this.definition = {
      name,
      description,
      inputSchema,
      source,
      version
    };
    this.client = client;
    this.inputSchema = z.object({}).passthrough() as any;
    this.outputSchema = z.object({}).passthrough() as any;
  }

  async execute(params: Record<string, any>): Promise<Record<string, any>> {
    console.log(`[DynamicMcpTool] Executing remote tool '${this.definition.name}' via PromptX MCP`);
    
    // Strip the namespace prefix (if any) to get the original tool name to call remote
    let remoteName = this.definition.name;
    const dotIndex = remoteName.indexOf(".");
    if (dotIndex !== -1) {
      remoteName = remoteName.substring(dotIndex + 1);
    }

    const response = await this.client.callTool(remoteName, params);
    return response;
  }
}
