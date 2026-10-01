import { IRetriever, IEmbeddingService, IVectorStore } from "./types";
import { KnowledgeResult } from "../schemas/validation";
import { resolveKnowledgeScope } from "./knowledgeScope";

export class VectorStoreRetriever implements IRetriever {
  private embeddingService: IEmbeddingService;
  private vectorStore: IVectorStore;

  constructor(embeddingService: IEmbeddingService, vectorStore: IVectorStore) {
    this.embeddingService = embeddingService;
    this.vectorStore = vectorStore;
  }

  async retrieve(query: string, filters?: { projectId?: string; tenantId?: string }): Promise<KnowledgeResult[]> {
    // Fail closed: without a project scope nothing is retrieved.
    const scope = resolveKnowledgeScope(filters);
    if (!scope) return [];
    const activeProjectId = scope.projectId;
    const activeTenantId = scope.tenantId;

    const queryVector = await this.embeddingService.embedQuery(query);
    const searchResults = await this.vectorStore.similaritySearch(queryVector, 5, scope);

    const filtered = searchResults.filter((doc) => {
      const docTenantId = doc.metadata?.tenantId || doc.metadata?.companyId || "1";
      // A document without a project tag belongs to no project.
      const docProjectId = doc.metadata?.projectId ?? doc.metadata?.project_id;
      if (docProjectId === undefined || docProjectId === null) return false;
      return String(docTenantId) === String(activeTenantId) && String(docProjectId) === String(activeProjectId);
    });

    return filtered.map((doc) => {
      let confidence = doc.score;
      confidence = Math.max(0.0, Math.min(1.0, parseFloat(confidence.toFixed(2))));

      return {
        source: "vector_store",
        id: doc.id,
        type: (doc.metadata?.type as "ticket" | "message" | "document") || "document",
        content: doc.content,
        confidence,
        metadata: doc.metadata,
      };
    });
  }
}
