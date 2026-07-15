import { ITool } from "../tools/types";
import { McpToolDefinition } from "../mcp/types";
import { IPieceAdapter } from "./types";
import { z } from "zod";

export class PieceMcpTool implements ITool {
  readonly definition: McpToolDefinition;
  readonly inputSchema: z.ZodObject<any> | z.ZodType<any>;
  readonly outputSchema: z.ZodObject<any> | z.ZodType<any>;

  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly owner: string;
  readonly asyncSyncCapability: "sync" | "async";
  readonly requiredPermissions: string[];

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

    this.name = definition.name;
    this.version = definition.version || "1.0.0";
    this.description = definition.description || `Piece action ${actionName}`;
    this.owner = definition.owner || "activepieces";
    this.asyncSyncCapability = (definition.asyncSyncCapability as any) || "sync";
    this.requiredPermissions = definition.requiredPermissions || [definition.name];
  }

  async execute(params: Record<string, any>, context?: any): Promise<Record<string, any>> {
    console.log(`[PieceMcpTool] Executing piece action ${this.pieceName}::${this.actionName}`);

    const authConnection = {
      apiToken: process.env.NOCODB_TOKEN || process.env.NOCODB_API_TOKEN,
      baseUrl: process.env.NOCODB_BASE_URL || "https://app.nocodb.com",
    };

    const result = await this.pieceAdapter.executeAction(this.pieceName, this.actionName, authConnection, params, context);

    return result;
  }
}
