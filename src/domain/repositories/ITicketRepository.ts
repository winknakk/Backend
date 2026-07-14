import { Ticket } from "../entities/Ticket";

export interface ITicketRepository {
  /**
   * Retrieves a ticket by its primary database ID.
   */
  findById(id: string): Promise<Ticket | null>;

  /**
   * Retrieves all tickets associated with a specific conversation.
   */
  findByConversationId(conversationId: string): Promise<Ticket[]>;

  /**
   * Saves a ticket domain entity.
   */
  save(ticket: Ticket): Promise<Ticket>;

  /**
   * Lists tickets scoped to a project with pagination support.
   */
  listPaginated(
    projectId: string,
    limit: number,
    cursor?: string
  ): Promise<{ rows: Ticket[]; nextCursor?: string }>;

  /**
   * Retrieves active (non-closed, non-merged) tickets in a specific project.
   */
  findActiveByProject(projectId: number): Promise<Ticket[]>;
}
