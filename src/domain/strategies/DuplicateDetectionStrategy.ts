import { Ticket } from "../entities/Ticket";

export interface DuplicateDetectionResult {
  isDuplicate: boolean;
  duplicateOfTicketId?: number;
  score: number;
  reason: string;
}

export interface DuplicateDetectionStrategy {
  detectDuplicate(ticket: Ticket, activeTickets: Ticket[]): Promise<DuplicateDetectionResult>;
}

export class SubjectMatchingDuplicateStrategy implements DuplicateDetectionStrategy {
  async detectDuplicate(ticket: Ticket, activeTickets: Ticket[]): Promise<DuplicateDetectionResult> {
    for (const active of activeTickets) {
      if (active.id === ticket.id) continue;
      
      // Temporary fallback: exact or highly similar subject string match
      const tSubject = ticket.subject.trim().toLowerCase();
      const aSubject = active.subject.trim().toLowerCase();

      if (tSubject === aSubject && tSubject.length > 5) {
        return {
          isDuplicate: true,
          duplicateOfTicketId: active.id,
          score: 1.00,
          reason: `Exact subject match with active Ticket ID: ${active.id} (Ref: ${active.ticketId})`,
        };
      }
    }
    return { isDuplicate: false, score: 0.00, reason: "" };
  }
}
