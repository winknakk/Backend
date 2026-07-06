import { IRetriever, IEmbeddingService, IVectorStore } from "./types";
import { KnowledgeResult } from "../schemas/validation";

export class VectorStoreRetriever implements IRetriever {
  private embeddingService: IEmbeddingService;
  private vectorStore: IVectorStore;

  constructor(embeddingService: IEmbeddingService, vectorStore: IVectorStore) {
    this.embeddingService = embeddingService;
    this.vectorStore = vectorStore;
  }

  async retrieve(query: string, filters?: { projectId?: string; tenantId?: string }): Promise<KnowledgeResult[]> {
    const queryVector = await this.embeddingService.embedQuery(query);
    const searchResults = await this.vectorStore.similaritySearch(queryVector, 5);

    const { getOptionalRequestContext } = require("../kernel/context/RequestContextHolder");
    const context = getOptionalRequestContext();
    const activeProjectId = context?.projectId || filters?.projectId || "1";
    const activeTenantId = context?.tenantId || filters?.tenantId || "1";

    const filtered = searchResults.filter((doc) => {
      const docTenantId = doc.metadata?.tenantId || doc.metadata?.companyId || "1";
      const docProjectId = doc.metadata?.projectId || "1";
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
