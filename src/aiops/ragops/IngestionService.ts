import { IVectorStore, IEmbeddingService } from "../../rag/types";
import { DocumentIngestionPayload, KnowledgeChunk } from "../../schemas/aiops";
import { DocumentParser } from "./DocumentParser";
import { resolveKnowledgeScope } from "../../rag/knowledgeScope";

export class KnowledgeScopeRequiredError extends Error {
  constructor() {
    super("Knowledge ingestion requires a project scope");
    this.name = "KnowledgeScopeRequiredError";
  }
}

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
    // No default project: an unscoped document would be readable by whichever
    // project the old fallback ("1") pointed at.
    const scope = resolveKnowledgeScope(payload);
    if (!scope) {
      throw new KnowledgeScopeRequiredError();
    }

    payload.projectId = scope.projectId;
    payload.tenantId = scope.tenantId;

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
      // Caller metadata first, scope fields last: uploaded metadata must not
      // be able to re-tag a document to another project or tenant.
      const metadata = {
        type: "document",
        ...chunk.metadata,
        docId: chunk.docId,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        chunkIndex: chunk.chunkIndex,
        title: payload.title,
        embedding: embeddings[index],
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
