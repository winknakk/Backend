import { FastifyInstance } from "fastify";
import { DatabaseAdapter } from "../../adapters/types";
import { SLAMatrixService } from "../../services/SLAMatrixService";
import { EmailNotificationService } from "../../services/EmailNotificationService";
import { z } from "zod";

const CreatePortalTicketSchema = z.object({
  customerId: z.string().min(1),
  projectId: z.string().min(1),
  subject: z.string().min(1),
  summary: z.string().min(1),
  priority: z.enum(["P1", "P2", "P3", "P4", "Urgent", "High", "Medium", "Low"]).default("P3"),
  severity: z.enum(["Critical", "High", "Medium", "Low"]).default("Medium"),
});

export function registerPortalRoutes(
  fastify: FastifyInstance,
  deps: { dbAdapter: DatabaseAdapter; slaService: SLAMatrixService; emailService?: EmailNotificationService }
) {
  // 1. Create ticket from Portal
  fastify.post("/api/portal/tickets", async (request, reply) => {
    const tenantCtx = request.tenantContext;
    const body = CreatePortalTicketSchema.parse(request.body);

    const convId = await deps.dbAdapter.ensureConversation(body.customerId, tenantCtx.orgId, "webchat");

    const slaInfo = await deps.slaService.calculateSLADueDate(body.projectId, body.priority);

    const randomSuffix = Math.floor(10000 + Math.random() * 90000);
    const ticketNumber = `TCK-${new Date().getFullYear()}-${randomSuffix}`;

    const result = await deps.dbAdapter.createTicket(
      {
        conversationId: convId,
        projectId: body.projectId,
        subject: body.subject,
        summary: body.summary,
        priority: body.priority,
        severity: body.severity,
      },
      slaInfo.dueDate,
      ticketNumber,
      tenantCtx
    );

    if (deps.emailService) {
      await deps.emailService.notifyTicketCreated("customer@avalant.co.th", ticketNumber, body.subject, tenantCtx).catch(() => undefined);
    }

    return reply.code(201).send({
      success: true,
      ticketNumber,
      dueDate: slaInfo.dueDate,
      result,
    });
  });

  // 2. List tickets for Customer Portal
  fastify.get("/api/portal/tickets", async (request, reply) => {
    const tenantCtx = request.tenantContext;
    const query = request.query as any;
    const projectId = query?.projectId ? String(query.projectId) : undefined;

    const tickets = await deps.dbAdapter.listAllTickets(undefined, projectId, undefined, undefined, tenantCtx);
    return reply.code(200).send({
      success: true,
      tenantOrgId: tenantCtx.orgId,
      tickets,
    });
  });

  // 3. Get single ticket detail for Portal
  fastify.get("/api/portal/tickets/:id", async (request, reply) => {
    const tenantCtx = request.tenantContext;
    const params = request.params as any;
    const ticketIdStr = String(params.id);

    const tickets = await deps.dbAdapter.listAllTickets(undefined, undefined, undefined, undefined, tenantCtx);
    const match = tickets.find((t: any) => String(t.id) === ticketIdStr || t.ticket_number === ticketIdStr || t.ticket_id === ticketIdStr);

    if (!match) {
      return reply.code(404).send({ error: "Ticket not found or unauthorized for tenant" });
    }

    const breachStatus = await deps.slaService.checkSLABreachStatus(match);

    return reply.code(200).send({
      success: true,
      ticket: match,
      slaStatus: breachStatus,
    });
  });
}
