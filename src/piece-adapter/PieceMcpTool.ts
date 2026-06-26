import { ITool } from "../tools/types";
import { McpToolDefinition } from "../mcp/types";
import { IPieceAdapter } from "./types";
import { z } from "zod";

export class PieceMcpTool implements ITool {
  readonly definition: McpToolDefinition;
  readonly inputSchema: z.ZodObject<any>;
  readonly outputSchema: z.ZodObject<any>;

  private pieceAdapter: IPieceAdapter;
  private pieceName: string;
  private actionName: string;

  constructor(pieceAdapter: IPieceAdapter, pieceName: string, actionName: string, definition: McpToolDefinition) {
    this.pieceAdapter = pieceAdapter;
    this.pieceName = pieceName;
    this.actionName = actionName;
    this.definition = definition;
    this.inputSchema = z.object({}).passthrough() as any;
    this.outputSchema = z.object({}).passthrough() as any;
  }

  async execute(params: Record<string, any>): Promise<Record<string, any>> {
    console.log(`[PieceMcpTool] Executing piece action ${this.pieceName}::${this.actionName}`);

    const authConnection = {
      apiToken: process.env.NOCODB_TOKEN || process.env.NOCODB_API_TOKEN,
      baseUrl: process.env.NOCODB_BASE_URL || "https://app.nocodb.com",
    };

    const result = await this.pieceAdapter.executeAction(this.pieceName, this.actionName, authConnection, params);

    return result;
  }
}
