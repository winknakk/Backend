import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { canAccessProject, resolveProjectFilter } from "../../middleware/tenantScope";
import { auditService } from "../../services/AuditService";
import { adminSocketRegistry } from "../AdminSocketRegistry";
import { createLogger } from "../../observability/logger";

const logger = createLogger("internal-notes-api");

/**
 * Resolves an operator ID integer from the request principal or database.
 */
async function resolveOperatorId(request: FastifyRequest): Promise<number> {
  const principal = request.principal;
  if (!principal) return 1;

  if (principal.subject && /^[0-9]+$/.test(principal.subject)) {
    return parseInt(principal.subject, 10);
  }

  if (principal.subject && principal.subject.includes("@")) {
    try {
      const res = await pool.query(
        `SELECT id FROM operators WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL LIMIT 1`,
        [principal.subject]
      );
      if (res.rows.length > 0 && res.rows[0].id) {
        return Number(res.rows[0].id);
      }
    } catch {
      // Fallback
    }
  }

  // Fallback to first available operator or 1
  try {
    const fallbackRes = await pool.query(`SELECT id FROM operators ORDER BY id ASC LIMIT 1`);
    if (fallbackRes.rows.length > 0) {
      return Number(fallbackRes.rows[0].id);
    }
  } catch {
    // Ignore
  }

  return 1;
}

export async function registerInternalNotesRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Helper to verify ticket exists and is within operator's project scope.
   */
  async function resolveAuthorizedTicket(
    request: FastifyRequest,
    reply: FastifyReply,
    ticketParam: string
  ): Promise<{ id: number; ticket_number: string; project_id: number; conversation_id: number | null } | null> {
    const isNumeric = /^[0-9]+$/.test(ticketParam);
    const querySql = isNumeric
      ? `SELECT id, ticket_id AS ticket_number, project_id, conversation_id FROM tickets WHERE id = $1 AND deleted_at IS NULL LIMIT 1`
      : `SELECT id, ticket_id AS ticket_number, project_id, conversation_id FROM tickets WHERE ticket_id = $1 AND deleted_at IS NULL LIMIT 1`;

    const res = await pool.query(querySql, [isNumeric ? parseInt(ticketParam, 10) : ticketParam]);
    if (res.rows.length === 0) {
      reply.status(404).send({ error: "Not Found", message: `Ticket ${ticketParam} not found` });
      return null;
    }

    const ticket = res.rows[0];
    if (!canAccessProject(request, ticket.project_id)) {
      reply.status(404).send({ error: "Not Found", message: `Ticket ${ticketParam} not found` });
      return null;
    }

    return {
      id: Number(ticket.id),
      ticket_number: String(ticket.ticket_number),
      project_id: Number(ticket.project_id),
      conversation_id: ticket.conversation_id ? Number(ticket.conversation_id) : null,
    };
  }

  // 1. GET /api/admin/tickets/:ticketId/notes
  fastify.get("/api/admin/tickets/:ticketId/notes", async (request, reply) => {
    const params = request.params as { ticketId: string };
    const ticket = await resolveAuthorizedTicket(request, reply, params.ticketId);
    if (!ticket) return;

    const query = (request.query || {}) as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(parseInt(query.limit || "50", 10) || 50, 1), 100);
    const offset = Math.max(parseInt(query.offset || "0", 10) || 0, 0);

    const countRes = await pool.query(
      `SELECT count(*)::int AS total FROM internal_notes WHERE ticket_id = $1`,
      [ticket.id]
    );
    const total = Number(countRes.rows[0]?.total || 0);

    const notesRes = await pool.query(
      `SELECT n.id, n.conversation_id, n.ticket_id, n.operator_id, n.content,
              n.is_pinned, n.mentioned_ops, n.created_at, n.updated_at,
              COALESCE(o.name, o.email, 'Operator') AS operator_name,
              o.email AS operator_email
       FROM internal_notes n
       LEFT JOIN operators o ON o.id = n.operator_id
       WHERE n.ticket_id = $1
       ORDER BY n.is_pinned DESC, n.created_at ASC
       LIMIT $2 OFFSET $3`,
      [ticket.id, limit, offset]
    );

    const notes = notesRes.rows.map((r: any) => ({
      id: Number(r.id),
      conversationId: Number(r.conversation_id),
      ticketId: Number(r.ticket_id),
      operatorId: Number(r.operator_id),
      operatorName: r.operator_name,
      operatorEmail: r.operator_email,
      content: r.content,
      isPinned: Boolean(r.is_pinned),
      mentionedOps: r.mentioned_ops || [],
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    }));

    return reply.send({ success: true, notes, total, limit, offset });
  });

  // 2. POST /api/admin/tickets/:ticketId/notes
  fastify.post("/api/admin/tickets/:ticketId/notes", async (request, reply) => {
    const params = request.params as { ticketId: string };
    const ticket = await resolveAuthorizedTicket(request, reply, params.ticketId);
    if (!ticket) return;

    const body = (request.body || {}) as { content?: string; isPinned?: boolean; mentionedOps?: number[] };
    const content = (body.content || "").trim();
    if (!content) {
      return reply.status(400).send({ error: "Bad Request", message: "content cannot be empty" });
    }

    const isPinned = Boolean(body.isPinned);
    const mentionedOps = Array.isArray(body.mentionedOps) ? body.mentionedOps.map((id) => Number(id)).filter(Number.isInteger) : [];

    if (mentionedOps.length > 0) {
      const opCheckRes = await pool.query(
        `SELECT o.id
         FROM operators o
         LEFT JOIN operator_project_access opa ON opa.operator_id = o.id AND opa.project_id = $1
         WHERE o.id = ANY($2::int[])
           AND o.deleted_at IS NULL
           AND (LOWER(COALESCE(o.role, '')) = 'super_admin' OR opa.project_id IS NOT NULL)`,
        [ticket.project_id, mentionedOps]
      );
      const validOpIds = new Set(opCheckRes.rows.map((r: any) => Number(r.id)));
      for (const opId of mentionedOps) {
        if (!validOpIds.has(opId)) {
          return reply.status(400).send({
            error: "Bad Request",
            message: `Operator ${opId} is not assigned to project ${ticket.project_id}`,
          });
        }
      }
    }

    let conversationId = ticket.conversation_id;
    if (!conversationId) {
      // Find from links
      const linkRes = await pool.query(
        `SELECT conversation_id FROM conversation_ticket_links WHERE ticket_id = $1 LIMIT 1`,
        [ticket.id]
      );
      if (linkRes.rows.length > 0 && linkRes.rows[0].conversation_id) {
        conversationId = Number(linkRes.rows[0].conversation_id);
      } else {
        // Fallback: lookup any existing conversation for this project
        const convRes = await pool.query(
          `SELECT id FROM conversations WHERE project_id = $1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
          [ticket.project_id]
        );
        if (convRes.rows.length > 0 && convRes.rows[0].id) {
          conversationId = Number(convRes.rows[0].id);
        } else {
          return reply.status(400).send({
            error: "Bad Request",
            message: "Cannot create internal note: no conversation is linked to this ticket",
          });
        }
      }
    }

    const operatorId = await resolveOperatorId(request);
    const actorName = request.principal?.subject || "operator";

    const insertRes = await pool.query(
      `INSERT INTO internal_notes (conversation_id, ticket_id, operator_id, content, is_pinned, mentioned_ops, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       RETURNING id, created_at, updated_at`,
      [conversationId, ticket.id, operatorId, content, isPinned, mentionedOps]
    );

    const newNoteId = Number(insertRes.rows[0].id);
    const createdAt = insertRes.rows[0].created_at instanceof Date ? insertRes.rows[0].created_at.toISOString() : String(insertRes.rows[0].created_at);

    // Record Audit
    await auditService.record({
      projectId: ticket.project_id,
      action: "NOTE_CREATED",
      actor: actorName,
      operatorId,
      newValue: {
        noteId: newNoteId,
        ticketId: ticket.id,
        ticketNumber: ticket.ticket_number,
        isPinned,
        contentLength: content.length,
      },
    });

    const notePayload = {
      id: newNoteId,
      conversationId,
      ticketId: ticket.id,
      operatorId,
      operatorName: actorName,
      content,
      isPinned,
      mentionedOps,
      createdAt,
      updatedAt: createdAt,
    };

    // Realtime notification scoped to project
    adminSocketRegistry.broadcastToProject(
      ticket.project_id,
      JSON.stringify({
        event: "ticket:note:added",
        data: { ticketId: ticket.id, note: notePayload },
      })
    );

    return reply.status(201).send({
      success: true,
      note: notePayload,
    });
  });

  // 3. PATCH /api/admin/tickets/:ticketId/notes/:noteId/pin
  fastify.patch("/api/admin/tickets/:ticketId/notes/:noteId/pin", async (request, reply) => {
    const params = request.params as { ticketId: string; noteId: string };
    const ticket = await resolveAuthorizedTicket(request, reply, params.ticketId);
    if (!ticket) return;

    const noteId = parseInt(params.noteId, 10);
    if (!Number.isInteger(noteId)) {
      return reply.status(400).send({ error: "Bad Request", message: "Invalid noteId" });
    }

    const body = (request.body || {}) as { isPinned?: boolean };
    const isPinned = body.isPinned !== false; // defaults to true if omitted

    const existingRes = await pool.query(
      `SELECT id, is_pinned FROM internal_notes WHERE id = $1 AND ticket_id = $2`,
      [noteId, ticket.id]
    );
    if (existingRes.rows.length === 0) {
      return reply.status(404).send({ error: "Not Found", message: `Note ${noteId} not found on this ticket` });
    }

    await pool.query(
      `UPDATE internal_notes SET is_pinned = $1, updated_at = NOW() WHERE id = $2`,
      [isPinned, noteId]
    );

    const operatorId = await resolveOperatorId(request);
    const actorName = request.principal?.subject || "operator";

    await auditService.record({
      projectId: ticket.project_id,
      action: isPinned ? "NOTE_PINNED" : "NOTE_UNPINNED",
      actor: actorName,
      operatorId,
      oldValue: { noteId, isPinned: existingRes.rows[0].is_pinned },
      newValue: { noteId, isPinned },
    });

    return reply.send({ success: true, noteId, isPinned });
  });

  // 4. DELETE /api/admin/tickets/:ticketId/notes/:noteId
  fastify.delete("/api/admin/tickets/:ticketId/notes/:noteId", async (request, reply) => {
    const params = request.params as { ticketId: string; noteId: string };
    const ticket = await resolveAuthorizedTicket(request, reply, params.ticketId);
    if (!ticket) return;

    const noteId = parseInt(params.noteId, 10);
    if (!Number.isInteger(noteId)) {
      return reply.status(400).send({ error: "Bad Request", message: "Invalid noteId" });
    }

    const existingRes = await pool.query(
      `SELECT id, content, is_pinned FROM internal_notes WHERE id = $1 AND ticket_id = $2`,
      [noteId, ticket.id]
    );
    if (existingRes.rows.length === 0) {
      return reply.status(404).send({ error: "Not Found", message: `Note ${noteId} not found on this ticket` });
    }

    await pool.query(`DELETE FROM internal_notes WHERE id = $1`, [noteId]);

    const operatorId = await resolveOperatorId(request);
    const actorName = request.principal?.subject || "operator";

    await auditService.record({
      projectId: ticket.project_id,
      action: "NOTE_DELETED",
      actor: actorName,
      operatorId,
      oldValue: { noteId, ticketId: ticket.id, isPinned: existingRes.rows[0].is_pinned },
    });

    return reply.send({ success: true, message: `Note ${noteId} deleted successfully` });
  });
}
