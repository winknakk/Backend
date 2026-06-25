import { z } from "zod";
import { McpToolDefinition } from "../mcp/types";

export interface ITool {
  /**
   * Metadata describing the tool's name, description, and inputs.
   * Maps directly to the MCP Tool Definition.
   */
  readonly definition: McpToolDefinition;

  /**
   * The validation schema representing the inputs.
   */
  readonly inputSchema: z.ZodObject<any>;

  /**
   * The validation schema representing the outputs.
   */
  readonly outputSchema: z.ZodObject<any>;

  /**
   * Executes the tool's core logic with validated parameters.
   */
  execute(params: Record<string, any>): Promise<Record<string, any>>;
}

export interface IToolRegistry {
  /**
   * Registers a tool to the local registry.
   */
  registerTool(tool: ITool): void;

  /**
   * Gets a tool by its unique name.
   */
  getTool(name: string): ITool | undefined;

  /**
   * Lists all tools registered in the system.
   */
  listTools(): ITool[];

  /**
   * Helper that returns tool definitions in the format required by the MCP server.
   */
  getMcpDefinitions(): McpToolDefinition[];
}

export interface IToolExecutionEngine {
  /**
   * Executes a tool by name, handling validation, logging, and routing.
   * Internally dispatches to the correct tool implementation (or the Piece Adapter).
   */
  executeTool(toolName: string, params: Record<string, any>, context?: any): Promise<Record<string, any>>;
}
