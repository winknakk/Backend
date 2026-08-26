import { BaseRepository } from "../../shared/repositories/BaseRepository";
import { Ticket } from "../../domain/entities/Ticket";
import { TicketMapper } from "./mappers/TicketMapper";

export class PostgresTicketRepository extends BaseRepository<Ticket, number> {
  async findById(id: number): Promise<Ticket | null> {
    const { rows } = await this.db.query(
      "SELECT * FROM tickets WHERE id = $1 LIMIT 1",
      [id]
    );
    if (rows.length === 0) return null;
    return TicketMapper.toDomain(rows[0]);
  }

  async findByIdForUpdate(id: number): Promise<Ticket | null> {
    const { rows } = await this.db.query(
      "SELECT * FROM tickets WHERE id = $1 LIMIT 1 FOR UPDATE",
      [id]
    );
    if (rows.length === 0) return null;
    return TicketMapper.toDomain(rows[0]);
  }

  async findByTicketId(ticketId: string): Promise<Ticket | null> {
    const { rows } = await this.db.query(
      "SELECT * FROM tickets WHERE ticket_number = $1 OR ticket_id = $1 LIMIT 1",
      [ticketId]
    );
    if (rows.length === 0) return null;
    return TicketMapper.toDomain(rows[0]);
  }

  async findByTicketIdForUpdate(ticketId: string): Promise<Ticket | null> {
    const { rows } = await this.db.query(
      "SELECT * FROM tickets WHERE ticket_number = $1 OR ticket_id = $1 LIMIT 1 FOR UPDATE",
      [ticketId]
    );
    if (rows.length === 0) return null;
    return TicketMapper.toDomain(rows[0]);
  }

  async findActiveByConversationAndSubject(conversationId: number, subject: string): Promise<Ticket | null> {
    const { rows } = await this.db.query(
      `SELECT *
       FROM tickets
       WHERE conversation_id = $1
         AND deleted_at IS NULL
         AND status NOT IN ('CLOSED', 'CANCELLED', 'CUSTOMER_CONFIRMED')
         AND (
           LOWER(REGEXP_REPLACE(TRIM(COALESCE(subject, '')), '\\s+', ' ', 'g'))
             = LOWER(REGEXP_REPLACE(TRIM($2::text), '\\s+', ' ', 'g'))
           OR (
             NULLIF(SUBSTRING(COALESCE(subject, '') FROM '\\m[1-5][0-9]{2}\\M'), '') IS NOT NULL
             AND SUBSTRING(COALESCE(subject, '') FROM '\\m[1-5][0-9]{2}\\M')
               = SUBSTRING($2::text FROM '\\m[1-5][0-9]{2}\\M')
           )
         )
       ORDER BY
         CASE WHEN LOWER(REGEXP_REPLACE(TRIM(COALESCE(subject, '')), '\\s+', ' ', 'g'))
           = LOWER(REGEXP_REPLACE(TRIM($2::text), '\\s+', ' ', 'g')) THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT 1`,
      [conversationId, subject]
    );
    if (rows.length === 0) return null;
    return TicketMapper.toDomain(rows[0]);
  }

  async findActiveByProject(projectId: number): Promise<Ticket[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM tickets 
       WHERE project_id = $1 
         AND conversation_id IS NOT NULL
         AND deleted_at IS NULL
         AND status NOT IN ('CLOSED', 'CANCELLED', 'CUSTOMER_CONFIRMED')`,
      [projectId]
    );
    return rows.map((r: any) => TicketMapper.toDomain(r));
  }

  async save(ticket: Ticket): Promise<Ticket> {
    const data = TicketMapper.toPersistence(ticket);

    if (ticket.id === 0) {
      // Insert new ticket
      const { rows } = await this.db.query(
        `INSERT INTO tickets (
          ticket_number, ticket_id, conversation_id, project_id, subject, summary, status, priority, severity, 
          assigned_pm, created_via, plane_issue_id, due_date, created_at,
          title, original_problem_statement, running_summary, last_ai_summary, 
          duplicate_of_ticket_id, duplicate_score, duplicate_reason, ai_confidence_metrics, searchable_text,
          enrichment_state, created_by_type, created_by_name, cancellation_reason
        ) VALUES (
          $1, $1, $2, $3, $4, $5, $6, $7, $8, 
          $9, $10, $11, $12, COALESCE($13, NOW()),
          $14, $15, $16, $17, 
          $18, $19, $20, $21, $22,
          $23, $24, $25, $26
        ) RETURNING id`,
        [
          data.ticket_id,
          data.conversation_id,
          data.project_id,
          data.subject,
          data.summary,
          data.status,
          data.priority,
          data.severity,
          data.assigned_pm,
          data.created_via,
          data.plane_issue_id,
          data.due_date,
          data.created_at,
          data.title,
          data.original_problem_statement,
          data.running_summary,
          data.last_ai_summary,
          data.duplicate_of_ticket_id,
          data.duplicate_score,
          data.duplicate_reason,
          data.ai_confidence_metrics,
          data.searchable_text,
          data.enrichment_state,
          data.created_by_type || 'CUSTOMER',
          data.created_by_name || null,
          data.cancellation_reason || null
        ]
      );
      ticket.assignDatabaseId(rows[0].id);
    } else {
      // Update existing ticket
      await this.db.query(
        `UPDATE tickets SET
          ticket_number = $1,
          ticket_id = $1,
          conversation_id = $2,
          project_id = $3,
          subject = $4,
          summary = $5,
          status = $6,
          priority = $7,
          severity = $8,
          assigned_pm = $9,
          created_via = $10,
          plane_issue_id = $11,
          due_date = $12,
          title = $13,
          original_problem_statement = $14,
          running_summary = $15,
          last_ai_summary = $16,
          duplicate_of_ticket_id = $17,
          duplicate_score = $18,
          duplicate_reason = $19,
          ai_confidence_metrics = $20,
          searchable_text = $21,
          enrichment_state = $22,
          created_by_type = COALESCE($23, created_by_type),
          created_by_name = COALESCE($24, created_by_name),
          cancellation_reason = COALESCE($25, cancellation_reason)
        WHERE id = $26`,
        [
          data.ticket_id,
          data.conversation_id,
          data.project_id,
          data.subject,
          data.summary,
          data.status,
          data.priority,
          data.severity,
          data.assigned_pm,
          data.created_via,
          data.plane_issue_id,
          data.due_date,
          data.title,
          data.original_problem_statement,
          data.running_summary,
          data.last_ai_summary,
          data.duplicate_of_ticket_id,
          data.duplicate_score,
          data.duplicate_reason,
          data.ai_confidence_metrics,
          data.searchable_text,
          data.enrichment_state,
          data.created_by_type || null,
          data.created_by_name || null,
          data.cancellation_reason || null,
          ticket.id
        ]
      );
    }

    return ticket;
  }

  async restoreTicket(id: number): Promise<Ticket | null> {
    const ticket = await this.findById(id);
    if (!ticket) return null;

    ticket.restore();
    return await this.save(ticket);
  }
}
