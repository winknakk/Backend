import { KnowledgeResult } from "../schemas/validation";

export interface IEmbeddingService {
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
}

export interface IVectorStore {
  addDocuments(documents: Array<{ id: string; content: string; metadata?: any }>): Promise<void>;
  similaritySearch(queryVector: number[], k?: number): Promise<Array<{ id: string; content: string; score: number; metadata?: any }>>;
}

export interface IRetriever {
  retrieve(query: string, filters?: { projectId?: string }): Promise<KnowledgeResult[]>;
}
