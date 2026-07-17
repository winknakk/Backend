import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { ITool, IToolRegistry } from "./types";
import { McpToolDefinition } from "../mcp/types";
import { TicketInputSchema, ExecutionResultSchema } from "../schemas/validation";
import { TicketService } from "./TicketService";
import { TransactionManager } from "../shared/repositories/TransactionManager";
import { UnitOfWork } from "../shared/repositories/UnitOfWork";
import { PostgresTicketRepository } from "../infrastructure/db/PostgresTicketRepository";
import { AdapterFactory } from "../adapters/AdapterFactory";
import { PlaneService, PlaneTicketClosureResult } from "../services/planeService";

// V2 Tool Contract Schema
export const McpToolRegistryV2Schema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  category: z.string(),
  owner: z.string(),
  executionMode: z.enum(["sync", "async"]),
  requiredPermissions: z.array(z.string()),
  backend: z.object({
    method: z.string(),
    endpoint: z.string(),
  }),
  inputSchema: z.record(z.string(), z.any()),
  outputSchema: z.record(z.string(), z.any()),
  events: z.object({
    publish: z.array(z.string()),
    subscribe: z.array(z.string()),
  }),
  automationX: z.object({
    flow: z.string(),
    waitForEvents: z.array(z.string()),
    nextEvents: z.array(z.string()),
  }),
  agentX: z.object({
    reasoningHints: z.array(z.string()),
    memoryUsage: z.string(),
    requiresEnrichedTicket: z.boolean(),
  }),
  retryPolicy: z.object({
    enabled: z.boolean(),
    maxAttempts: z.number(),
    backoff: z.string(),
  }),
  idempotency: z.object({
    enabled: z.boolean(),
    key: z.string().optional(),
  }),
  observability: z.object({
    metrics: z.array(z.string()),
    logs: z.array(z.string()),
    trace: z.boolean(),
  }),
});

export class CreateTicketTool implements ITool {
  definition!: McpToolDefinition;
  readonly name = "create_ticket";
  readonly inputSchema = TicketInputSchema;
  readonly outputSchema = ExecutionResultSchema;

  private ticketService: TicketService;

  constructor(ticketService: TicketService) {
    this.ticketService = ticketService;
  }

  async execute(params: Record<string, any>, context?: any): Promise<Record<string, any>> {
    const input = TicketInputSchema.parse(params);
    const result = await this.ticketService.createTicket(input);
    return ExecutionResultSchema.parse(result);
  }
}

export class GetTicketTool implements ITool {
  definition!: McpToolDefinition;
  readonly name = "get_ticket";
  readonly inputSchema = z.object({
    ticketId: z.string().min(1),
  });
  readonly outputSchema = ExecutionResultSchema;

  async execute(params: Record<string, any>, context?: any): Promise<Record<string, any>> {
    const ticketIdStr = String(params.ticketId);
    const txManager = new TransactionManager();
    const ticketRepo = new PostgresTicketRepository(txManager);
    let ticket = await ticketRepo.findByTicketId(ticketIdStr);
    if (!ticket && /^\d+$/.test(ticketIdStr)) {
      ticket = await ticketRepo.findById(parseInt(ticketIdStr, 10));
    }
    if (!ticket) {
      return {
        success: false,
        data: null,
        error: `Ticket not found: ${ticketIdStr}`,
        source: "local",
        executionId: require("crypto").randomUUID(),
      };
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
        aiConfidenceMetrics: ticket.aiConfidenceMetrics,
      },
      error: null,
      source: "local",
      executionId: require("crypto").randomUUID(),
    };
  }
}

export class GetTicketStatusTool implements ITool {
  definition!: McpToolDefinition;
  readonly name = "get_ticket_status";
  readonly inputSchema = z.object({
    ticketId: z.string().min(1),
  });
  readonly outputSchema = ExecutionResultSchema;

  async execute(params: Record<string, any>, context?: any): Promise<Record<string, any>> {
    const ticketIdStr = String(params.ticketId);
    const txManager = new TransactionManager();
    const ticketRepo = new PostgresTicketRepository(txManager);
    let ticket = await ticketRepo.findByTicketId(ticketIdStr);
    if (!ticket && /^\d+$/.test(ticketIdStr)) {
      ticket = await ticketRepo.findById(parseInt(ticketIdStr, 10));
    }
    if (!ticket) {
      return {
        success: false,
        data: null,
        error: `Ticket not found: ${ticketIdStr}`,
        source: "local",
        executionId: require("crypto").randomUUID(),
      };
    }
    return {
      success: true,
      data: {
        ticketId: ticket.ticketId,
        status: ticket.status,
        enrichmentState: ticket.enrichmentState,
        aiConfidenceMetrics: ticket.aiConfidenceMetrics,
        duplicateOfTicketId: ticket.duplicateOfTicketId,
        duplicateScore: ticket.duplicateScore,
        duplicateReason: ticket.duplicateReason,
        processingMetadata: {
          createdVia: ticket.createdVia,
          createdAt: ticket.createdAt.toISOString(),
          dueDate: ticket.dueDate?.toISOString() || null,
          assignedPm: ticket.assignedPm,
        },
      },
      error: null,
      source: "local",
      executionId: require("crypto").randomUUID(),
    };
  }
}

export class UpdateSummaryTool implements ITool {
  definition!: McpToolDefinition;
  readonly name = "update_summary";
  readonly inputSchema = z.object({
    ticketId: z.string().min(1),
    runningSummary: z.string().min(1),
    lastAiSummary: z.string().min(1),
  });
  readonly outputSchema = ExecutionResultSchema;

  async execute(params: Record<string, any>, context?: any): Promise<Record<string, any>> {
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
      executionId: require("crypto").randomUUID(),
    };
  }
}

export class FindTicketTool implements ITool {
  definition!: McpToolDefinition;
  readonly name = "find_ticket";
  readonly inputSchema = z.object({
    projectId: z.string().optional(),
    status: z.string().optional(),
    conversationId: z.string().optional(),
  });
  readonly outputSchema = ExecutionResultSchema;

  async execute(params: Record<string, any>, context?: any): Promise<Record<string, any>> {
    const dbAdapter = AdapterFactory.getAdapter();
    const tickets = await dbAdapter.listAllTickets(params.conversationId, params.projectId);
    let filtered = tickets;
    if (params.status) {
      filtered = tickets.filter(
        (t) => String(t.status || t.fields?.status || "").toLowerCase() === String(params.status).toLowerCase()
      );
    }
    return {
      success: true,
      data: filtered,
      error: null,
      source: "local",
      executionId: require("crypto").randomUUID(),
    };
  }
}

export class MergeTicketTool implements ITool {
  definition!: McpToolDefinition;
  readonly name = "merge_ticket";
  readonly inputSchema = z.object({
    ticketId: z.string().min(1),
    primaryTicketId: z.string().min(1),
    reason: z.string().min(1),
  });
  readonly outputSchema = ExecutionResultSchema;

  async execute(params: Record<string, any>, context?: any): Promise<Record<string, any>> {
    const ticketIdStr = String(params.ticketId);
    const primaryIdStr = String(params.primaryTicketId);
    const txManager = new TransactionManager();
    const uow = new UnitOfWork(txManager);
    const ticketRepo = new PostgresTicketRepository(txManager);

    let alreadyMerged = false;

    await uow.execute(async () => {
      let ticket = await ticketRepo.findByTicketId(ticketIdStr);
      if (!ticket && /^\d+$/.test(ticketIdStr)) ticket = await ticketRepo.findById(parseInt(ticketIdStr, 10));
      if (!ticket) throw new Error(`Ticket to merge not found: ${ticketIdStr}`);

      let primary = await ticketRepo.findByTicketId(primaryIdStr);
      if (!primary && /^\d+$/.test(primaryIdStr)) primary = await ticketRepo.findById(parseInt(primaryIdStr, 10));
      if (!primary) throw new Error(`Primary ticket not found: ${primaryIdStr}`);

      // Idempotency check
      if (ticket.duplicateOfTicketId === primary.id && ticket.status === "merged") {
        alreadyMerged = true;
        return;
      }

      ticket.markDuplicate(primary.id, 1.0, params.reason);
      uow.registerAggregate(ticket);
      await ticketRepo.save(ticket);
    });

    return {
      success: true,
      data: { ticketId: ticketIdStr, merged: true, alreadyMerged },
      error: null,
      source: "local",
      executionId: require("crypto").randomUUID(),
    };
  }
}

export class CloseTicketTool implements ITool {
  definition!: McpToolDefinition;
  readonly name = "close_ticket";
  readonly inputSchema = z.object({
    ticketId: z.string().min(1),
  });
  readonly outputSchema = ExecutionResultSchema;

  constructor(private readonly planeService?: Pick<PlaneService, "syncTicketClosureToPlane">) {}

  async execute(params: Record<string, any>, context?: any): Promise<Record<string, any>> {
    const ticketIdStr = String(params.ticketId);
    const txManager = new TransactionManager();
    const uow = new UnitOfWork(txManager);
    const ticketRepo = new PostgresTicketRepository(txManager);

    let alreadyClosed = false;
    let planeSync: PlaneTicketClosureResult | undefined;

    // Update Plane first. If it fails, PostgreSQL remains unchanged instead of
    // being reopened by the Plane-to-PostgreSQL reconciliation poller.
    if (this.planeService) {
      planeSync = await this.planeService.syncTicketClosureToPlane(ticketIdStr);
    }

    await uow.execute(async () => {
      let ticket = await ticketRepo.findByTicketId(ticketIdStr);
      if (!ticket && /^\d+$/.test(ticketIdStr)) ticket = await ticketRepo.findById(parseInt(ticketIdStr, 10));
      if (!ticket) throw new Error(`Ticket not found: ${ticketIdStr}`);

      // Idempotency check
      if (ticket.status === "closed") {
        alreadyClosed = true;
        return;
      }

      ticket.close();
      uow.registerAggregate(ticket);
      await ticketRepo.save(ticket);
    });

    return {
      success: true,
      data: { ticketId: ticketIdStr, status: "closed", alreadyClosed, planeSync },
      error: null,
      source: "local",
      executionId: require("crypto").randomUUID(),
    };
  }
}

export class AssignTicketTool implements ITool {
  definition!: McpToolDefinition;
  readonly name = "assign_ticket";
  readonly inputSchema = z.object({
    ticketId: z.string().min(1),
    agentId: z.string().min(1),
  });
  readonly outputSchema = ExecutionResultSchema;

  async execute(params: Record<string, any>, context?: any): Promise<Record<string, any>> {
    const ticketIdStr = String(params.ticketId);
    const txManager = new TransactionManager();
    const uow = new UnitOfWork(txManager);
    const ticketRepo = new PostgresTicketRepository(txManager);

    let alreadyAssigned = false;

    await uow.execute(async () => {
      let ticket = await ticketRepo.findByTicketId(ticketIdStr);
      if (!ticket && /^\d+$/.test(ticketIdStr)) ticket = await ticketRepo.findById(parseInt(ticketIdStr, 10));
      if (!ticket) throw new Error(`Ticket not found: ${ticketIdStr}`);

      // Idempotency check
      if (ticket.assignedPm === params.agentId) {
        alreadyAssigned = true;
        return;
      }

      ticket.assign(params.agentId);
      uow.registerAggregate(ticket);
      await ticketRepo.save(ticket);
    });

    return {
      success: true,
      data: { ticketId: ticketIdStr, assignedPm: params.agentId, alreadyAssigned },
      error: null,
      source: "local",
      executionId: require("crypto").randomUUID(),
    };
  }
}

export class EscalateToPmTool implements ITool {
  definition!: McpToolDefinition;
  readonly name = "escalate_to_pm";
  readonly inputSchema = z.object({
    ticketId: z.string().min(1),
    reason: z.string().min(1),
  });
  readonly outputSchema = ExecutionResultSchema;

  async execute(params: Record<string, any>, context?: any): Promise<Record<string, any>> {
    const ticketIdStr = String(params.ticketId);
    const txManager = new TransactionManager();
    const ticketRepo = new PostgresTicketRepository(txManager);
    let ticket = await ticketRepo.findByTicketId(ticketIdStr);
    if (!ticket && /^\d+$/.test(ticketIdStr)) ticket = await ticketRepo.findById(parseInt(ticketIdStr, 10));
    if (!ticket) throw new Error(`Ticket not found: ${ticketIdStr}`);

    try {
      const axios = require("axios");
      const { config } = require("../config/env");

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (context?.correlationId) {
        headers["x-correlation-id"] = context.correlationId;
      }
      if (context?.traceId) {
        headers["x-trace-id"] = context.traceId;
      }

      await axios.post(
        `${config.PROMPTX_FLOW_WEBHOOK_URL || "http://localhost:3000"}/api/v1/webhooks/human_notify`,
        {
          conversationId: ticket.conversationId,
          role: "system",
          content: `Ticket ${ticket.ticketId} escalated to PM: ${params.reason}. AI Title: ${
            ticket.title || "Pending"
          }. Running Summary: ${ticket.runningSummary || "Pending"}`,
        },
        {
          headers,
          timeout: 5000,
        }
      );
    } catch (err: any) {
      console.error("Failed to post human notification for escalation:", err.message);
    }

    return {
      success: true,
      data: { ticketId: ticketIdStr, escalated: true },
      error: null,
      source: "local",
      executionId: require("crypto").randomUUID(),
    };
  }
}

export class ToolRegistry implements IToolRegistry {
  private tools: Map<string, ITool> = new Map();
  private jsonDefinitions: Map<string, any> = new Map();

  constructor() {
    this.loadJsonDefinitions();
  }

  private loadJsonDefinitions() {
    let dir = path.resolve(__dirname, "./definitions");
    if (!fs.existsSync(dir)) {
      dir = path.resolve(__dirname, "../../src/tools/definitions");
    }
    if (!fs.existsSync(dir)) {
      console.warn(`[ToolRegistry] Definitions directory not found.`);
      return;
    }
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const raw = fs.readFileSync(path.join(dir, file), "utf-8");
          const parsed = JSON.parse(raw);
          const validated = McpToolRegistryV2Schema.parse(parsed);
          this.jsonDefinitions.set(validated.name, validated);
        }
      }
    } catch (e: any) {
      console.error(`[ToolRegistry] Error loading JSON definitions:`, e.message);
    }
  }

  registerTool(tool: ITool): void {
    const name = tool.name || tool.definition?.name;
    if (!name) {
      throw new Error(`Tool lacks a name property.`);
    }

    // Dynamic schema metadata binding from loaded JSON contracts
    const config = this.jsonDefinitions.get(name);
    if (config) {
      Object.assign(tool, {
        name: config.name,
        version: config.version,
        description: config.description,
        owner: config.owner,
        asyncSyncCapability: config.executionMode,
        requiredPermissions: config.requiredPermissions,
        definition: {
          name: config.name,
          description: config.description,
          inputSchema: config.inputSchema,
          version: config.version,
          owner: config.owner,
          asyncSyncCapability: config.executionMode,
          requiredPermissions: config.requiredPermissions,
        },
      });
    } else {
      // Create a fallback definition if JSON doesn't exist
      if (!tool.definition) {
        Object.assign(tool, {
          definition: {
            name,
            description: tool.description || "Fallback definition",
            inputSchema: { type: "object", properties: {} },
            version: "1.0.0",
            owner: "unknown",
            asyncSyncCapability: "sync",
            requiredPermissions: [name],
          },
        });
      }
    }

    if (this.tools.has(name)) {
      console.warn(`[ToolRegistry] Tool '${name}' is already registered. Skipping duplicate.`);
      return;
    }
    this.tools.set(name, tool);
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
