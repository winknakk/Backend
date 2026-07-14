import { Ticket } from "../domain/entities/Ticket";
import { PostgresTicketRepository } from "../infrastructure/db/PostgresTicketRepository";
import { PostgresTicketEventRepository } from "../infrastructure/db/PostgresTicketEventRepository";
import { TransactionManager } from "../shared/repositories/TransactionManager";
import { UnitOfWork } from "../shared/repositories/UnitOfWork";
import { ConfigLoaderService } from "../services/ConfigLoaderService";
import { BackupManager } from "../adapters/postgres/BackupManager";
import { BullMQEventPublisher } from "../infrastructure/queue/BullMQEventPublisher";
import { TicketInput, ExecutionResult } from "../schemas/validation";
import { DatabaseAdapter } from "../adapters/types";

export class TicketService {
  private dbAdapter: DatabaseAdapter;
  private txManager: TransactionManager;
  private ticketRepo: PostgresTicketRepository;
  private eventRepo: PostgresTicketEventRepository;
  private uow: UnitOfWork;

  constructor(dbAdapter: DatabaseAdapter) {
    this.dbAdapter = dbAdapter;
    this.txManager = new TransactionManager();
    this.ticketRepo = new PostgresTicketRepository(this.txManager);
    this.eventRepo = new PostgresTicketEventRepository(this.txManager);
    this.uow = new UnitOfWork(this.txManager);
  }

  async createTicket(input: TicketInput): Promise<ExecutionResult> {
    // 1. Calculate SLA Due Date dynamically based on project SLA policies
    let resolveHours = 120; // default fallback
    try {
      const configLoader = ConfigLoaderService.getInstance();
      const projectId = input.projectId || "1";
      const slaConfig = await configLoader.getSlaPolicy(projectId);
      const policy = slaConfig.policies.find((p) => p.priority === input.priority);
      if (policy) {
        resolveHours = policy.resolveHours;
      }
    } catch (err: any) {
      console.error("Failed to query resolve_hours dynamically for ticket creation SLA calculation:", err.message);
    }

    const startDate = new Date();
    const dueDate = new Date(startDate.getTime() + resolveHours * 60 * 60 * 1000);

    // 2. Generate Sequential Mock Ticket Number: TCK-YYYY-[5-digit random]
    const currentYear = startDate.getFullYear();
    const randomSuffix = Math.floor(10000 + Math.random() * 90000);
    const ticketNumber = `TCK-${currentYear}-${randomSuffix}`;

    // 3. Save to database via UnitOfWork & PostgresTicketRepository
    try {
      const projectIdNum = parseInt(input.projectId, 10) || 1;
      const conversationIdNum = parseInt(input.conversationId, 10);

      const ticket = Ticket.create({
        ticketId: ticketNumber,
        conversationId: conversationIdNum,
        projectId: projectIdNum,
        subject: input.subject,
        summary: input.summary,
        status: "Open",
        priority: input.priority,
        severity: input.severity,
        dueDate,
        createdAt: startDate,
        createdVia: "ai",
      });

      const eventPublisher = new BullMQEventPublisher();

      await this.uow.execute(
        async () => {
          this.uow.registerAggregate(ticket);
          await this.ticketRepo.save(ticket);
          await this.eventRepo.saveEvents(ticket, "system", "AI", "Line");

          // Write outbox event transactionally using active client
          const outboxPayload = { ticketId: ticketNumber };
          const client = this.txManager.getClient();
          await client.query(
            `INSERT INTO outbox_events (event_type, payload, status, attempts)
             VALUES ($1, $2, $3, $4)`,
            ["TicketCreated", JSON.stringify(outboxPayload), "pending", 0]
          );
        },
        async (events) => {
          await eventPublisher.publish(events);
        }
      );

      // Return matching interface
      const resultData = {
        id: ticket.id.toString(),
        ticketId: ticketNumber,
        conversationId: ticket.conversationId.toString(),
        subject: ticket.subject,
        summary: ticket.summary,
        severity: ticket.severity,
        priority: ticket.priority,
        projectId: input.projectId,
        status: ticket.status as any,
        startDate: ticket.createdAt.toISOString(),
        dueDate: dueDate.toISOString(),
        createdBy: "AI Support Agent",
        enrichmentState: ticket.enrichmentState,
        aiConfidenceMetrics: ticket.aiConfidenceMetrics
      };

      // Write to local encrypted backup
      await BackupManager.saveToBackup("tickets", resultData, "id");

      return {
        success: true,
        data: resultData,
        error: null,
        source: "postgres",
        executionId: require("crypto").randomUUID(),
      };
    } catch (err: any) {
      console.error("Failed to create ticket via Repository & UoW in TicketService:", err.message);
      return {
        success: false,
        data: null,
        error: err.message ?? "Unknown error creating ticket",
        source: "postgres",
        executionId: require("crypto").randomUUID(),
      };
    }
  }
}
