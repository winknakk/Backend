import { ITool, IToolRegistry, IToolExecutionEngine } from "./types";
import { McpToolDefinition } from "../mcp/types";
import { TicketInputSchema, ExecutionResultSchema, TicketInput } from "../schemas/validation";
import { TicketService } from "./TicketService";

export class CreateTicketTool implements ITool {
  readonly definition: McpToolDefinition = {
    name: "create_ticket",
    description: "Create a support ticket in NocoDB database for human operator resolution.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "The active conversation ID" },
        subject: { type: "string", description: "Short summary of the issue (at least 5 chars)" },
        summary: { type: "string", description: "Full detailed description of the problem (at least 10 chars)" },
        severity: { type: "string", description: "Severity: Critical, High, Medium, Low" },
        priority: { type: "string", description: "Priority: P1, P2, P3, P4" },
        projectId: { type: "string", description: "The relevant project ID" }
      },
      required: ["conversationId", "subject", "summary", "severity", "priority", "projectId"]
    }
  };

  readonly inputSchema = TicketInputSchema;
  readonly outputSchema = ExecutionResultSchema;

  private ticketService: TicketService;

  constructor(ticketService: TicketService) {
    this.ticketService = ticketService;
  }

  async execute(params: Record<string, any>): Promise<Record<string, any>> {
    // Input is validated by PolicyEngine before reaching here, but we parse here too for type-safety.
    const input = TicketInputSchema.parse(params);
    const result = await this.ticketService.createTicket(input);
    return ExecutionResultSchema.parse(result);
  }
}

export class ToolRegistry implements IToolRegistry {
  private tools: Map<string, ITool> = new Map();

  registerTool(tool: ITool): void {
    if (this.tools.has(tool.definition.name)) {
      console.warn(`[ToolRegistry] Tool '${tool.definition.name}' is already registered. Skipping duplicate.`);
      return;
    }
    this.tools.set(tool.definition.name, tool);
  }

  getTool(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  listTools(): ITool[] {
    return Array.from(this.tools.values());
  }

  getMcpDefinitions(): McpToolDefinition[] {
    return this.listTools().map(t => t.definition);
  }
}
