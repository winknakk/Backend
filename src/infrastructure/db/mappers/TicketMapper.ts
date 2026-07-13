import { Ticket } from "../../../domain/entities/Ticket";

export class TicketMapper {
  static toDomain(raw: any): Ticket {
    return new Ticket({
      id: raw.id,
      ticketId: raw.ticket_id,
      conversationId: raw.conversation_id,
      projectId: raw.project_id ? Number(raw.project_id) : null,
      subject: raw.subject,
      summary: raw.summary || undefined,
      status: raw.status,
      priority: raw.priority || undefined,
      severity: raw.severity || undefined,
      assignedPm: raw.assigned_pm || undefined,
      createdVia: raw.created_via || undefined,
      planeIssueId: raw.plane_issue_id || undefined,
      dueDate: raw.due_date ? new Date(raw.due_date) : null,
      createdAt: raw.created_at ? new Date(raw.created_at) : undefined,

      title: raw.title || undefined,
      originalProblemStatement: raw.original_problem_statement || undefined,
      runningSummary: raw.running_summary || undefined,
      lastAiSummary: raw.last_ai_summary || undefined,
      duplicateOfTicketId: raw.duplicate_of_ticket_id || null,
      duplicateScore: raw.duplicate_score ? Number(raw.duplicate_score) : 0.00,
      duplicateReason: raw.duplicate_reason || undefined,
      aiConfidenceMetrics: typeof raw.ai_confidence_metrics === "string"
        ? JSON.parse(raw.ai_confidence_metrics)
        : raw.ai_confidence_metrics,
      searchableText: raw.searchable_text || undefined,
    });
  }

  static toPersistence(domain: Ticket): any {
    return {
      id: domain.id,
      ticket_id: domain.ticketId,
      conversation_id: domain.conversationId,
      project_id: domain.projectId || null,
      subject: domain.subject,
      summary: domain.summary || null,
      status: domain.status,
      priority: domain.priority || null,
      severity: domain.severity || null,
      assigned_pm: domain.assignedPm || null,
      created_via: domain.createdVia || null,
      plane_issue_id: domain.planeIssueId || null,
      due_date: domain.dueDate ? domain.dueDate.toISOString() : null,
      created_at: domain.createdAt.toISOString(),

      title: domain.title || null,
      original_problem_statement: domain.originalProblemStatement || null,
      running_summary: domain.runningSummary || null,
      last_ai_summary: domain.lastAiSummary || null,
      duplicate_of_ticket_id: domain.duplicateOfTicketId || null,
      duplicate_score: domain.duplicateScore,
      duplicate_reason: domain.duplicateReason || null,
      ai_confidence_metrics: JSON.stringify(domain.aiConfidenceMetrics),
      searchable_text: domain.searchableText || null,
    };
  }
}
