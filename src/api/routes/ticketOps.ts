import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { canAccessProject } from "../../middleware/tenantScope";
import { auditService } from "../../services/AuditService";
import { adminSocketRegistry } from "../AdminSocketRegistry";
import { createLogger } from "../../observability/logger";

const logger = createLogger("ticket-ops-api");

export async function registerTicketOpsRoutes(fastify: FastifyInstance): Promise<void> {
  // 1. POST /api/admin/tickets/:id/merge
  fastify.post("/api/admin/tickets/:id/merge", async (request, reply) => {
    const params = request.params as { id: string };
    const sourceParam = params.id;
    const body = (request.body || {}) as { targetTicketId?: string | number; reason?: string };

    if (!body.targetTicketId) {
      return reply.status(400).send({ error: "Bad Request", message: "targetTicketId is required" });
    }

    const sourceIsNum = /^[0-9]+$/.test(sourceParam);
    const targetParam = String(body.targetTicketId).trim();
    const targetIsNum = /^[0-9]+$/.test(targetParam);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Fetch source ticket FOR UPDATE
      const sourceSql = sourceIsNum
        ? `SELECT t.id, t.ticket_id, t.project_id, t.conversation_id, t.status, t.operator_id, t.duplicate_of_ticket_id, c.identity_id
           FROM tickets t
           LEFT JOIN conversations c ON c.id = t.conversation_id
           WHERE t.id = $1 AND t.deleted_at IS NULL
           FOR UPDATE OF t`
        : `SELECT t.id, t.ticket_id, t.project_id, t.conversation_id, t.status, t.operator_id, t.duplicate_of_ticket_id, c.identity_id
           FROM tickets t
           LEFT JOIN conversations c ON c.id = t.conversation_id
           WHERE t.ticket_id = $1 AND t.deleted_at IS NULL
           FOR UPDATE OF t`;

      const sourceRes = await client.query(sourceSql, [sourceIsNum ? parseInt(sourceParam, 10) : sourceParam]);
      if (sourceRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Not Found", message: `Source ticket ${sourceParam} not found` });
      }
      const source = sourceRes.rows[0];

      // 2. Fetch target ticket FOR UPDATE
      const targetSql = targetIsNum
        ? `SELECT t.id, t.ticket_id, t.project_id, t.conversation_id, t.status, t.operator_id, t.duplicate_of_ticket_id, c.identity_id
           FROM tickets t
           LEFT JOIN conversations c ON c.id = t.conversation_id
           WHERE t.id = $1 AND t.deleted_at IS NULL
           FOR UPDATE OF t`
        : `SELECT t.id, t.ticket_id, t.project_id, t.conversation_id, t.status, t.operator_id, t.duplicate_of_ticket_id, c.identity_id
           FROM tickets t
           LEFT JOIN conversations c ON c.id = t.conversation_id
           WHERE t.ticket_id = $1 AND t.deleted_at IS NULL
           FOR UPDATE OF t`;

      const targetRes = await client.query(targetSql, [targetIsNum ? parseInt(targetParam, 10) : targetParam]);
      if (targetRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Not Found", message: `Target ticket ${targetParam} not found` });
      }
      const target = targetRes.rows[0];

      // 3. Verify source != target
      if (Number(source.id) === Number(target.id)) {
        await client.query("ROLLBACK");
        return reply.status(400).send({ error: "Bad Request", message: "Cannot merge a ticket into itself" });
      }

      // 4. Project authorization check
      if (!canAccessProject(request, source.project_id) || !canAccessProject(request, target.project_id)) {
        await client.query("ROLLBACK");
        return reply.status(403).send({ error: "Forbidden", message: "Cross-tenant ticket operations are strictly forbidden" });
      }

      if (Number(source.project_id) !== Number(target.project_id)) {
        await client.query("ROLLBACK");
        return reply.status(400).send({ error: "Bad Request", message: "Cannot merge tickets from different projects" });
      }

      // 5. Customer identity check (must match if both are present)
      if (source.identity_id && target.identity_id && Number(source.identity_id) !== Number(target.identity_id)) {
        await client.query("ROLLBACK");
        return reply.status(400).send({
          error: "Bad Request",
          message: "Cannot merge tickets belonging to different customer identities",
        });
      }

      // 6. Status and mergeability checks
      const TERMINAL_STATUSES = ["closed", "cancelled", "resolved"];
      if (TERMINAL_STATUSES.includes(String(source.status).toLowerCase())) {
        await client.query("ROLLBACK");
        return reply.status(400).send({
          error: "Bad Request",
          message: `Source ticket is already in terminal status '${source.status}'`,
        });
      }

      if (TERMINAL_STATUSES.includes(String(target.status).toLowerCase())) {
        await client.query("ROLLBACK");
        return reply.status(400).send({
          error: "Bad Request",
          message: `Target ticket #${target.ticket_id} is in terminal status '${target.status}'. Merging into a terminal ticket is forbidden.`,
        });
      }

      if (source.duplicate_of_ticket_id) {
        await client.query("ROLLBACK");
        return reply.status(400).send({
          error: "Bad Request",
          message: `Source ticket #${source.ticket_id} has already been merged into #${source.duplicate_of_ticket_id}`,
        });
      }

      const mergeReason = (body.reason || "Duplicate inquiry merged by operator").trim();
      const actorName = request.principal?.subject || "operator";

      // 7. Update source ticket to resolved/duplicate
      await client.query(
        `UPDATE tickets
         SET status = 'resolved',
             duplicate_of_ticket_id = $1,
             duplicate_reason = $2,
             resolved_at = NOW(),
             closed_at = NOW()
         WHERE id = $3`,
        [target.id, mergeReason, source.id]
      );

      // 8. Add internal note to target ticket
      if (target.conversation_id) {
        await client.query(
          `INSERT INTO internal_notes (conversation_id, ticket_id, operator_id, content, is_pinned, created_at, updated_at)
           VALUES ($1, $2, $3, $4, false, NOW(), NOW())`,
          [
            target.conversation_id,
            target.id,
            source.operator_id || 1,
            `Merged duplicate ticket #${source.ticket_id} into this ticket. Reason: ${mergeReason}`,
          ]
        );
      }

      // 9. Redirect conversational focus if any conversation was pointing to source ticket
      await client.query(
        `UPDATE conversations
         SET active_ticket_id = $1, updated_at = NOW()
         WHERE active_ticket_id = $2`,
        [target.id, source.id]
      );

      // 10. Record audit log
      await auditService.record(
        {
          projectId: Number(source.project_id),
          action: "TICKET_MERGE",
          actor: actorName,
          operatorId: source.operator_id ? Number(source.operator_id) : null,
          oldValue: {
            sourceTicketId: source.id,
            sourceTicketNumber: source.ticket_id,
            sourceStatus: source.status,
          },
          newValue: {
            targetTicketId: target.id,
            targetTicketNumber: target.ticket_id,
            reason: mergeReason,
          },
        },
        client
      );

      await client.query("COMMIT");

      // Broadcast WebSocket
      adminSocketRegistry.broadcastToProject(
        source.project_id,
        JSON.stringify({
          event: "ticket:merged",
          data: {
            sourceTicketId: Number(source.id),
            sourceTicketNumber: source.ticket_id,
            targetTicketId: Number(target.id),
            targetTicketNumber: target.ticket_id,
          },
        })
      );

      return reply.send({
        success: true,
        message: `Ticket #${source.ticket_id} merged into #${target.ticket_id} successfully`,
        sourceTicketId: Number(source.id),
        targetTicketId: Number(target.id),
      });
    } catch (err: any) {
      await client.query("ROLLBACK");
      logger.error({ error: err.message, sourceParam }, "Failed to merge tickets");
      return reply.status(500).send({ error: "Internal Server Error", message: err.message });
    } finally {
      client.release();
    }
  });

  // 2. POST /api/admin/tickets/:id/reassign
  fastify.post("/api/admin/tickets/:id/reassign", async (request, reply) => {
    const params = request.params as { id: string };
    const ticketParam = params.id;
    const body = (request.body || {}) as { assigneeId?: string | number; reason?: string };

    if (!body.assigneeId) {
      return reply.status(400).send({ error: "Bad Request", message: "assigneeId is required" });
    }

    const isNumeric = /^[0-9]+$/.test(ticketParam);
    const assigneeId = parseInt(String(body.assigneeId), 10);
    if (!Number.isInteger(assigneeId)) {
      return reply.status(400).send({ error: "Bad Request", message: "Invalid assigneeId" });
    }

    // 1. Verify ticket exists and access
    const ticketSql = isNumeric
      ? `SELECT id, ticket_id, project_id, operator_id, status FROM tickets WHERE id = $1 AND deleted_at IS NULL LIMIT 1`
      : `SELECT id, ticket_id, project_id, operator_id, status FROM tickets WHERE ticket_id = $1 AND deleted_at IS NULL LIMIT 1`;

    const ticketRes = await pool.query(ticketSql, [isNumeric ? parseInt(ticketParam, 10) : ticketParam]);
    if (ticketRes.rows.length === 0) {
      return reply.status(404).send({ error: "Not Found", message: `Ticket ${ticketParam} not found` });
    }

    const ticket = ticketRes.rows[0];
    if (!canAccessProject(request, ticket.project_id)) {
      return reply.status(404).send({ error: "Not Found", message: `Ticket ${ticketParam} not found` });
    }

    // 2. Verify target operator exists and is active
    const opRes = await pool.query(
      `SELECT id, email, role, is_active FROM operators WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [assigneeId]
    );
    if (opRes.rows.length === 0 || opRes.rows[0].is_active === false) {
      return reply.status(400).send({ error: "Bad Request", message: `Operator ${assigneeId} not found or inactive` });
    }

    const targetOp = opRes.rows[0];

    // 3. Verify operator has project access (super_admin has global access)
    if (String(targetOp.role).toLowerCase() !== "super_admin") {
      const accessRes = await pool.query(
        `SELECT 1 FROM operator_project_access WHERE operator_id = $1 AND project_id = $2 LIMIT 1`,
        [assigneeId, ticket.project_id]
      );
      if (accessRes.rows.length === 0) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Operator ${assigneeId} is not assigned to project ${ticket.project_id}`,
        });
      }
    }

    // 4. Update ticket
    await pool.query(
      `UPDATE tickets SET operator_id = $1, assigned_pm = $2, updated_at = NOW() WHERE id = $3`,
      [assigneeId, targetOp.email, ticket.id]
    );

    // 5. Audit log
    const actorName = request.principal?.subject || "operator";
    await auditService.record({
      projectId: Number(ticket.project_id),
      action: "TICKET_REASSIGNED",
      actor: actorName,
      oldValue: {
        ticketId: Number(ticket.id),
        previousOperatorId: ticket.operator_id ? Number(ticket.operator_id) : null,
      },
      newValue: {
        ticketId: Number(ticket.id),
        newOperatorId: assigneeId,
        newOperatorEmail: targetOp.email,
        reason: body.reason || null,
      },
    });

    return reply.send({
      success: true,
      message: `Ticket #${ticket.ticket_id} reassigned to ${targetOp.email}`,
      ticketId: Number(ticket.id),
      assignedTo: assigneeId,
    });
  });
}
