import { z } from "zod";

// Zod schemas representing Model Context Protocol (MCP) data shapes
export const McpToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.object({
    type: z.literal("object"),
    properties: z.record(z.string(), z.any()),
    required: z.array(z.string()).optional(),
  }),
  source: z.string().optional(),
  version: z.string().optional(),
});
export type McpToolDefinition = z.infer<typeof McpToolDefinitionSchema>;

export const McpRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.record(z.string(), z.any()).optional(),
});
export type McpRequest = z.infer<typeof McpRequestSchema>;

export const McpResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.any().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.any().optional(),
    })
    .optional(),
});
export type McpResponse = z.infer<typeof McpResponseSchema>;

export interface IMcpServer {
  /**
   * Starts the MCP Server using the specified transport protocol (SSE or Stdio).
   */
  start(): Promise<void>;

  /**
   * Stops the server and releases ports/sockets.
   */
  stop(): Promise<void>;

  /**
   * Exposes a new tool on the MCP server.
   */
  registerTool(tool: McpToolDefinition, handler: (params: any) => Promise<any>): void;

  /**
   * Processes a raw incoming JSON-RPC request and returns the corresponding response.
   */
  handleRequest(request: McpRequest): Promise<McpResponse>;
}
