import { z } from "zod";
import { McpToolDefinition } from "../mcp/types";
import { Ticket, TicketInput, ExecutionResult } from "../schemas/validation";

export const PieceMetadataSchema = z.object({
  name: z.string(),
  version: z.string(),
  displayName: z.string(),
  description: z.string(),
});
export type PieceMetadata = z.infer<typeof PieceMetadataSchema>;

export interface IPieceAdapter {
  getPieceMetadata(pieceName: string): Promise<PieceMetadata>;
  generateMcpDefinition(pieceName: string, actionName: string): Promise<McpToolDefinition>;
  executeAction(pieceName: string, actionName: string, authConnection: any, props: Record<string, any>): Promise<any>;
  listActions(pieceName: string): Promise<string[]>;
}

export interface INocoDBAdapter {
  /**
   * Creates a ticket record in NocoDB.
   * If live database is unavailable:
   * - In development, falls back to returning a mock ticket with source "nocodb_mock".
   * - In production, throws an error.
   */
  createTicket(input: TicketInput, slaDueDate: string, ticketNumber: string): Promise<ExecutionResult>;
}
