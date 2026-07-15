import { IPieceAdapter, PieceMetadata } from "./types";
import { McpToolDefinition } from "../mcp/types";
import axios from "axios";

export class PieceAdapter implements IPieceAdapter {
  private mockPieces: Record<string, PieceMetadata> = {
    "@activepieces/piece-nocodb": {
      name: "@activepieces/piece-nocodb",
      version: "0.4.4",
      displayName: "NocoDB",
      description: "Creates, updates, deletes, and searches records in NocoDB database.",
    },
  };

  async getPieceMetadata(pieceName: string): Promise<PieceMetadata> {
    const meta = this.mockPieces[pieceName];
    if (!meta) {
      throw new Error(`Piece '${pieceName}' is not loaded in V2 Adapter registry.`);
    }
    return meta;
  }

  async generateMcpDefinition(pieceName: string, actionName: string): Promise<McpToolDefinition> {
    const meta = await this.getPieceMetadata(pieceName);

    if (pieceName === "@activepieces/piece-nocodb" && actionName === "nocodb-create-record") {
      return {
        name: "activepieces.nocodb_create_record",
        description: `[Piece: ${meta.displayName}] Creates a new record in the given table.`,
        inputSchema: {
          type: "object",
          properties: {
            baseId: { type: "string", description: "The Base ID in NocoDB" },
            tableId: { type: "string", description: "The Table ID in NocoDB" },
            tableColumns: { type: "object", description: "The record columns to insert as a key-value object" },
          },
          required: ["baseId", "tableId", "tableColumns"],
        },
        source: "activepieces",
        version: meta.version,
      };
    }

    return {
      name: actionName.replace(/-/g, "_"),
      description: `[Piece: ${meta.displayName}] Runs action ${actionName}`,
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      source: "activepieces",
      version: meta.version,
    };
  }

  async executeAction(
    pieceName: string,
    actionName: string,
    authConnection: any,
    props: Record<string, any>,
    context?: any
  ): Promise<any> {
    console.log(`[PieceAdapter] Calling Piece Action '${pieceName}::${actionName}'...`);

    if (pieceName === "@activepieces/piece-nocodb" && actionName === "nocodb-create-record") {
      const { baseId, tableId, tableColumns } = props;
      const apiToken = authConnection?.apiToken || process.env.NOCODB_TOKEN || process.env.NOCODB_API_TOKEN;
      const baseUrl = authConnection?.baseUrl || process.env.NOCODB_BASE_URL || "https://app.nocodb.com";

      if (!apiToken) {
        throw new Error("NocoDB API token is missing for PieceAdapter execution.");
      }
      if (!baseId || !tableId) {
        throw new Error("baseId and tableId are required fields for NocoDB create record action.");
      }

      console.log(`[PieceAdapter] NocoDB Create Record: baseId=${baseId}, tableId=${tableId}`);
      try {
        const headers: Record<string, string> = {
          "xc-token": apiToken,
          "Content-Type": "application/json",
        };
        if (context?.correlationId) {
          headers["x-correlation-id"] = context.correlationId;
        }
        if (context?.traceId) {
          headers["x-trace-id"] = context.traceId;
        }

        const response = await axios.post(`${baseUrl}/api/v1/db/data/v1/${baseId}/${tableId}`, tableColumns, {
          headers,
          timeout: 5000,
        });
        return {
          success: true,
          data: response.data,
          error: null,
          source: "nocodb_piece",
        };
      } catch (e: any) {
        const errorMsg = e.response?.data?.message || e.message || String(e);
        console.error(`[PieceAdapter] NocoDB Piece execution failed: ${errorMsg}`);

        if (process.env.NODE_ENV === "production") {
          return {
            success: false,
            data: null,
            error: `NocoDB Piece execution failed: ${errorMsg}`,
            source: "nocodb_piece",
          };
        } else {
          // Dev fallback
          console.warn("[PieceAdapter] Dev fallback: returning simulated ticket record.");
          return {
            success: true,
            data: { id: "mock-piece-id", ...tableColumns },
            error: null,
            source: "nocodb_piece_mock",
          };
        }
      }
    }

    throw new Error(`Piece action ${pieceName}::${actionName} is not implemented.`);
  }

  async listActions(pieceName: string): Promise<string[]> {
    if (pieceName === "@activepieces/piece-nocodb") {
      return ["nocodb-create-record"];
    }
    return [];
  }
}
