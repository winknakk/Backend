import { IRetriever, IEmbeddingService, IVectorStore } from "./types";
import { KnowledgeResult } from "../schemas/validation";

export class VectorStoreRetriever implements IRetriever {
  private embeddingService: IEmbeddingService;
  private vectorStore: IVectorStore;

  constructor(embeddingService: IEmbeddingService, vectorStore: IVectorStore) {
    this.embeddingService = embeddingService;
    this.vectorStore = vectorStore;
  }

  async retrieve(query: string, filters?: { projectId?: string }): Promise<KnowledgeResult[]> {
    const queryVector = await this.embeddingService.embedQuery(query);
    const searchResults = await this.vectorStore.similaritySearch(queryVector, 5);

    let filtered = searchResults;
    if (filters?.projectId) {
      filtered = searchResults.filter(
        (doc) => doc.metadata?.projectId === filters.projectId
      );
    }

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
