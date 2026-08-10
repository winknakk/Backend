import { DatabaseAdapter } from "../../adapters/types";
import { KnowledgeResult } from "../../schemas/validation";
import { IRetriever } from "../../rag/types";
import { KeywordRetriever } from "../../rag/KeywordRetriever";

export class KnowledgeService {
  private retriever: IRetriever;

  constructor(dbAdapter: DatabaseAdapter, retriever?: IRetriever) {
    this.retriever = retriever || new KeywordRetriever(dbAdapter);
  }

  /**
   * Queries retriever directly with tenant-aware scoping.
   */
  async searchProjects(query: string, filters?: { projectId?: string; orgId?: string; tenantId?: string }): Promise<KnowledgeResult[]> {
    return this.retriever.retrieve(query, filters);
  }

  /**
   * Preserves exact API compatibility for tools calling searchKnowledgeBase with optional orgId.
   */
  async searchKnowledgeBase(query: string, projectId?: string, orgId?: string): Promise<KnowledgeResult[]> {
    return this.retriever.retrieve(query, { projectId, orgId, tenantId: orgId });
  }
}
