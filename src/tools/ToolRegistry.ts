import { z } from "zod";
import { ITool, IToolRegistry } from "./types";
import { McpToolDefinition } from "../mcp/types";
import { TicketInputSchema, ExecutionResultSchema } from "../schemas/validation";
import { TicketService } from "./TicketService";
import { TransactionManager } from "../shared/repositories/TransactionManager";
import { UnitOfWork } from "../shared/repositories/UnitOfWork";
import { PostgresTicketRepository } from "../infrastructure/db/PostgresTicketRepository";
import { AdapterFactory } from "../adapters/AdapterFactory";

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
        projectId: { type: "string", description: "The relevant project ID" },
      },
      required: ["conversationId", "subject", "summary", "severity", "priority", "projectId"],
    },
  };

  readonly inputSchema = TicketInputSchema;
  readonly outputSchema = ExecutionResultSchema;

  private ticketService: TicketService;

  constructor(ticketService: TicketService) {
    this.ticketService = ticketService;
  }

  async execute(params: Record<string, any>): Promise<Record<string, any>> {
    const input = TicketInputSchema.parse(params);
    const result = await this.ticketService.createTicket(input);
    return ExecutionResultSchema.parse(result);
  }
}

export class GetTicketTool implements ITool {
  readonly definition: McpToolDefinition = {
    name: "get_ticket",
    description: "Retrieve complete details of a support ticket by its readable ID (e.g. TCK-YYYY-XXXXX) or database serial ID.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "The ticket readable ID or database serial ID" }
      },
      required: ["ticketId"]
    }
  };

  readonly inputSchema = z.object({
    ticketId: z.string().min(1)
  });
  readonly outputSchema = ExecutionResultSchema;

  async execute(params: Record<string, any>): Promise<Record<string, any>> {
    const ticketIdStr = String(params.ticketId);
    const txManager = new TransactionManager();
    const ticketRepo = new PostgresTicketRepository(txManager);
    let ticket = await ticketRepo.findByTicketId(ticketIdStr);
    if (!ticket && /^\d+$/.test(ticketIdStr)) {
      ticket = await ticketRepo.findById(parseInt(ticketIdStr, 10));
    }
    if (!ticket) {
      return { success: false, data: null, error: `Ticket not found: ${ticketIdStr}`, source: "local", executionId: require("crypto").randomUUID() };
    }
    return {
      success: true,
      data: {
        id: ticket.id.toString(),
        ticketId: ticket.ticketId,
        conversationId: ticket.conversationId.toString(),
        projectId: ticket.projectId?.toString() || "1",
        subject: ticket.subject,
        summary: ticket.summary,
        status: ticket.status,
        priority: ticket.priority,
        severity: ticket.severity,
        assignedPm: ticket.assignedPm,
        createdVia: ticket.createdVia,
        planeIssueId: ticket.planeIssueId,
        dueDate: ticket.dueDate?.toISOString() || null,
        createdAt: ticket.createdAt.toISOString(),
        enrichmentState: ticket.enrichmentState,
        aiTitle: ticket.title,
        runningSummary: ticket.runningSummary,
        lastAiSummary: ticket.lastAiSummary,
        duplicateOfTicketId: ticket.duplicateOfTicketId,
        duplicateScore: ticket.duplicateScore,
        duplicateReason: ticket.duplicateReason,
        aiConfidenceMetrics: ticket.aiConfidenceMetrics
      },
      error: null,
      source: "local",
      executionId: require("crypto").randomUUID()
    };
  }
}

export class GetTicketStatusTool implements ITool {
  readonly definition: McpToolDefinition = {
    name: "get_ticket_status",
    description: "Retrieve lightweight status details of a support ticket including enrichment progress.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "The ticket readable ID or database serial ID" }
      },
      required: ["ticketId"]
    }
  };

  readonly inputSchema = z.object({
    ticketId: z.string().min(1)
  });
  readonly outputSchema = ExecutionResultSchema;

  async execute(params: Record<string, any>): Promise<Record<string, any>> {
    const ticketIdStr = String(params.ticketId);
    const txManager = new TransactionManager();
    const ticketRepo = new PostgresTicketRepository(txManager);
    let ticket = await ticketRepo.findByTicketId(ticketIdStr);
    if (!ticket && /^\d+$/.test(ticketIdStr)) {
      ticket = await ticketRepo.findById(parseInt(ticketIdStr, 10));
    }
    if (!ticket) {
      return { success: false, data: null, error: `Ticket not found: ${ticketIdStr}`, source: "local", executionId: require("crypto").randomUUID() };
    }
    return {
      success: true,
      data: {
        ticketId: ticket.ticketId,
        status: ticket.status,
        enrichmentState: ticket.enrichmentState,
        aiConfidenceMetrics: ticket.aiConfidenceMetrics
      },
      error: null,
      source: "local",
      executionId: require("crypto").randomUUID()
    };
  }
}

export class UpdateSummaryTool implements ITool {
  readonly definition: McpToolDefinition = {
    name: "update_summary",
    description: "Manually update the ticket AI summary override (agent manual corrections).",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "The ticket ID" },
        runningSummary: { type: "string", description: "New running summary content" },
        lastAiSummary: { type: "string", description: "New AI summary content" }
      },
      required: ["ticketId", "runningSummary", "lastAiSummary"]
    }
  };

  readonly inputSchema = z.object({
    ticketId: z.string().min(1),
    runningSummary: z.string().min(1),
    lastAiSummary: z.string().min(1)
  });
  readonly outputSchema = ExecutionResultSchema;

  async execute(params: Record<string, any>): Promise<Record<string, any>> {
    const ticketIdStr = String(params.ticketId);
    const txManager = new TransactionManager();
    const uow = new UnitOfWork(txManager);
    const ticketRepo = new PostgresTicketRepository(txManager);
    
    await uow.execute(async () => {
      let ticket = await ticketRepo.findByTicketId(ticketIdStr);
      if (!ticket && /^\d+$/.test(ticketIdStr)) {
        ticket = await ticketRepo.findById(parseInt(ticketIdStr, 10));
      }
      if (!ticket) throw new Error(`Ticket not found: ${ticketIdStr}`);
      
      ticket.updateSummary(params.runningSummary, params.lastAiSummary);
      uow.registerAggregate(ticket);
      await ticketRepo.save(ticket);
    });
    
    return {
      success: true,
      data: { ticketId: ticketIdStr, updated: true },
      error: null,
      source: "local",
      executionId: require("crypto").randomUUID()
    };
  }
}

export class FindTicketTool implements ITool {
  readonly definition: McpToolDefinition = {
    name: "find_ticket",
    description: "Search and filter tickets by project, status, or conversation.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        status: { type: "string" },
        conversationId: { type: "string" }
      }
    }
  };

  readonly inputSchema = z.object({
    projectId: z.string().optional(),
    status: z.string().optional(),
    conversationId: z.string().optional()
  });
  readonly outputSchema = ExecutionResultSchema;

  async execute(params: Record<string, any>): Promise<Record<string, any>> {
    const dbAdapter = AdapterFactory.getAdapter();
    const tickets = await dbAdapter.listAllTickets(params.conversationId, params.projectId);
    let filtered = tickets;
    if (params.status) {
      filtered = tickets.filter(t => String(t.status || t.fields?.status || "").toLowerCase() === String(params.status).toLowerCase());
    }
    return {
      success: true,
      data: filtered,
      error: null,
      source: "local",
      executionId: require("crypto").randomUUID()
    };
  }
}

export class MergeTicketTool implements ITool {
  readonly definition: McpToolDefinition = {
    name: "merge_ticket",
    description: "Merge a duplicate ticket into a primary ticket.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "Duplicate ticket to merge" },
        primaryTicketId: { type: "string", description: "Target primary ticket ID" },
        reason: { type: "string", description: "Reason for merge" }
      },
      required: ["ticketId", "primaryTicketId", "reason"]
    }
  };

  readonly inputSchema = z.object({
    ticketId: z.string().min(1),
    primaryTicketId: z.string().min(1),
    reason: z.string().min(1)
  });
  readonly outputSchema = ExecutionResultSchema;

  async execute(params: Record<string, any>): Promise<Record<string, any>> {
    const ticketIdStr = String(params.ticketId);
    const primaryIdStr = String(params.primaryTicketId);
    const txManager = new TransactionManager();
    const uow = new UnitOfWork(txManager);
    const ticketRepo = new PostgresTicketRepository(txManager);

    await uow.execute(async () => {
      let ticket = await ticketRepo.findByTicketId(ticketIdStr);
      if (!ticket && /^\d+$/.test(ticketIdStr)) ticket = await ticketRepo.findById(parseInt(ticketIdStr, 10));
      if (!ticket) throw new Error(`Ticket to merge not found: ${ticketIdStr}`);

      let primary = await ticketRepo.findByTicketId(primaryIdStr);
      if (!primary && /^\d+$/.test(primaryIdStr)) primary = await ticketRepo.findById(parseInt(primaryIdStr, 10));
      if (!primary) throw new Error(`Primary ticket not found: ${primaryIdStr}`);

      ticket.markDuplicate(primary.id, 1.0, params.reason);
      uow.registerAggregate(ticket);
      await ticketRepo.save(ticket);
    });

    return {
      success: true,
      data: { ticketId: ticketIdStr, merged: true },
      error: null,
      source: "local",
      executionId: require("crypto").randomUUID()
    };
  }
}

export class CloseTicketTool implements ITool {
  readonly definition: McpToolDefinition = {
    name: "close_ticket",
    description: "Close a resolved ticket.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "The ticket ID to close" }
      },
      required: ["ticketId"]
    }
  };

  readonly inputSchema = z.object({
    ticketId: z.string().min(1)
  });
  readonly outputSchema = ExecutionResultSchema;

  async execute(params: Record<string, any>): Promise<Record<string, any>> {
    const ticketIdStr = String(params.ticketId);
    const txManager = new TransactionManager();
    const uow = new UnitOfWork(txManager);
    const ticketRepo = new PostgresTicketRepository(txManager);

    await uow.execute(async () => {
      let ticket = await ticketRepo.findByTicketId(ticketIdStr);
      if (!ticket && /^\d+$/.test(ticketIdStr)) ticket = await ticketRepo.findById(parseInt(ticketIdStr, 10));
      if (!ticket) throw new Error(`Ticket not found: ${ticketIdStr}`);

      ticket.close();
      uow.registerAggregate(ticket);
      await ticketRepo.save(ticket);
    });

    return {
      success: true,
      data: { ticketId: ticketIdStr, status: "closed" },
      error: null,
      source: "local",
      executionId: require("crypto").randomUUID()
    };
  }
}

export class AssignTicketTool implements ITool {
  readonly definition: McpToolDefinition = {
    name: "assign_ticket",
    description: "Assign a ticket to a human agent.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "The ticket ID" },
        agentId: { type: "string", description: "Agent ID or name to assign" }
      },
      required: ["ticketId", "agentId"]
    }
  };

  readonly inputSchema = z.object({
    ticketId: z.string().min(1),
    agentId: z.string().min(1)
  });
  readonly outputSchema = ExecutionResultSchema;

  async execute(params: Record<string, any>): Promise<Record<string, any>> {
    const ticketIdStr = String(params.ticketId);
    const txManager = new TransactionManager();
    const uow = new UnitOfWork(txManager);
    const ticketRepo = new PostgresTicketRepository(txManager);

    await uow.execute(async () => {
      let ticket = await ticketRepo.findByTicketId(ticketIdStr);
      if (!ticket && /^\d+$/.test(ticketIdStr)) ticket = await ticketRepo.findById(parseInt(ticketIdStr, 10));
      if (!ticket) throw new Error(`Ticket not found: ${ticketIdStr}`);

      ticket.assign(params.agentId);
      uow.registerAggregate(ticket);
      await ticketRepo.save(ticket);
    });

    return {
      success: true,
      data: { ticketId: ticketIdStr, assignedPm: params.agentId },
      error: null,
      source: "local",
      executionId: require("crypto").randomUUID()
    };
  }
}

export class EscalateToPmTool implements ITool {
  readonly definition: McpToolDefinition = {
    name: "escalate_to_pm",
    description: "Escalate support ticket to the Project Manager.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "The ticket ID" },
        reason: { type: "string", description: "Reason for escalation" }
      },
      required: ["ticketId", "reason"]
    }
  };

  readonly inputSchema = z.object({
    ticketId: z.string().min(1),
    reason: z.string().min(1)
  });
  readonly outputSchema = ExecutionResultSchema;

  async execute(params: Record<string, any>): Promise<Record<string, any>> {
    const ticketIdStr = String(params.ticketId);
    const txManager = new TransactionManager();
    const ticketRepo = new PostgresTicketRepository(txManager);
    let ticket = await ticketRepo.findByTicketId(ticketIdStr);
    if (!ticket && /^\d+$/.test(ticketIdStr)) ticket = await ticketRepo.findById(parseInt(ticketIdStr, 10));
    if (!ticket) throw new Error(`Ticket not found: ${ticketIdStr}`);

    try {
      const axios = require("axios");
      const { config } = require("../config/env");
      await axios.post(`${config.PROMPTX_FLOW_WEBHOOK_URL || "http://localhost:3000"}/api/v1/webhooks/human_notify`, {
        conversationId: ticket.conversationId,
        role: "system",
        content: `Ticket ${ticket.ticketId} escalated to PM: ${params.reason}. AI Title: ${ticket.title || "Pending"}. Running Summary: ${ticket.runningSummary || "Pending"}`
      });
    } catch (err: any) {
      console.error("Failed to post human notification for escalation:", err.message);
    }

    return {
      success: true,
      data: { ticketId: ticketIdStr, escalated: true },
      error: null,
      source: "local",
      executionId: require("crypto").randomUUID()
    };
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
    return this.listTools().map((t) => t.definition);
  }
}
export default ToolRegistry;
