import { IEmbeddingService, IVectorStore } from "./types";

export class InMemoryVectorStore implements IVectorStore {
  private documents: Array<{ id: string; content: string; vector: number[]; metadata?: any }> = [];
  private embeddingService: IEmbeddingService;

  constructor(embeddingService: IEmbeddingService) {
    this.embeddingService = embeddingService;
  }

  async addDocuments(documents: Array<{ id: string; content: string; metadata?: any }>): Promise<void> {
    const contents = documents.map((doc) => doc.content);
    const vectors = await this.embeddingService.embedDocuments(contents);
    for (let i = 0; i < documents.length; i++) {
      this.documents.push({
        id: documents[i].id,
        content: documents[i].content,
        vector: vectors[i],
        metadata: documents[i].metadata,
      });
    }
  }

  async similaritySearch(
    queryVector: number[],
    k: number = 5
  ): Promise<Array<{ id: string; content: string; score: number; metadata?: any }>> {
    const results = this.documents.map((doc) => {
      const score = this.cosineSimilarity(queryVector, doc.vector);
      return {
        id: doc.id,
        content: doc.content,
        score,
        metadata: doc.metadata,
      };
    });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0;
    let mA = 0;
    let mB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      mA += a[i] * a[i];
      mB += b[i] * b[i];
    }
    if (mA === 0 || mB === 0) return 0;
    return dotProduct / (Math.sqrt(mA) * Math.sqrt(mB));
  }
}
