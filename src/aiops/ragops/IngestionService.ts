import { IVectorStore, IEmbeddingService } from "../../rag/types";
import { DocumentIngestionPayload, KnowledgeChunk } from "../../schemas/aiops";
import { DocumentParser } from "./DocumentParser";

export class IngestionService {
  private vectorStore: IVectorStore;
  private embeddingService: IEmbeddingService;

  constructor(vectorStore: IVectorStore, embeddingService: IEmbeddingService) {
    this.vectorStore = vectorStore;
    this.embeddingService = embeddingService;
  }

  /**
   * Chunks, embeds, and indexes document payloads to VectorStore enforcing tenantId.
   */
  async ingestDocument(payload: DocumentIngestionPayload): Promise<KnowledgeChunk[]> {
    // 1. Chunk document
    const chunks = DocumentParser.parse(payload);
    if (chunks.length === 0) {
      return [];
    }

    // 2. Generate embeddings
    const contents = chunks.map((c) => c.content);
    const embeddings = await this.embeddingService.embedDocuments(contents);

    // 3. Prepare documents for VectorStore
    const documentsToStore = chunks.map((chunk, index) => {
      const metadata = {
        docId: chunk.docId,
        tenantId: chunk.tenantId,
        projectId: chunk.projectId,
        chunkIndex: chunk.chunkIndex,
        title: payload.title,
        embedding: embeddings[index],
        type: "document",
        ...chunk.metadata,
      };

      // Set the metadata in the chunk object as well
      chunk.metadata = metadata;

      return {
        id: chunk.chunkId,
        content: chunk.content,
        metadata,
      };
    });

    // 4. Index in VectorStore
    await this.vectorStore.addDocuments(documentsToStore);

    return chunks;
  }
}
