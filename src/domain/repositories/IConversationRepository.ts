import { Conversation } from "../entities/Conversation";

export interface IConversationRepository {
  /**
   * Retrieves a conversation by its primary database ID.
   */
  findById(id: string): Promise<Conversation | null>;

  /**
   * Retrieves the active conversation associated with a customer identity.
   */
  findActiveByIdentity(identityId: string, projectId: string): Promise<Conversation | null>;

  /**
   * Saves a conversation domain entity (insert or update).
   */
  save(conversation: Conversation): Promise<Conversation>;

  /**
   * Lists conversations scoped to a project with pagination support.
   */
  listPaginated(
    projectId: string,
    limit: number,
    cursor?: string
  ): Promise<{ rows: Conversation[]; nextCursor?: string }>;
}
