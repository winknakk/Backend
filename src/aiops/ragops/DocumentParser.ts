import { DocumentIngestionPayload, KnowledgeChunk } from "../../schemas/aiops";
import { randomUUID } from "crypto";

export class DocumentParser {
  /**
   * Splits a document into overlapping chunks.
   * @param payload The document payload to parse
   * @param chunkSize Maximum characters per chunk
   * @param overlap Characters of overlap between chunks
   */
  static parse(payload: DocumentIngestionPayload, chunkSize = 500, overlap = 50): KnowledgeChunk[] {
    const content = payload.content;
    const docId = randomUUID();
    const chunks: KnowledgeChunk[] = [];

    if (!content) {
      return [];
    }

    if (content.length <= chunkSize) {
      chunks.push({
        chunkId: randomUUID(),
        docId,
        tenantId: payload.tenantId,
        projectId: payload.projectId,
        content: content.trim(),
        chunkIndex: 0,
        metadata: {
          title: payload.title,
          ...payload.metadata,
        },
      });
      return chunks;
    }

    let start = 0;
    let chunkIndex = 0;

    while (start < content.length) {
      let end = start + chunkSize;
      if (end > content.length) {
        end = content.length;
      }

      // Try to find a clean word or sentence boundary within the last 20% of the chunk
      if (end < content.length) {
        const searchRange = content.substring(end - Math.floor(chunkSize * 0.2), end);
        const lastPeriod = searchRange.lastIndexOf(".");
        const lastNewline = searchRange.lastIndexOf("\n");
        const lastSpace = searchRange.lastIndexOf(" ");

        if (lastPeriod !== -1) {
          end = end - Math.floor(chunkSize * 0.2) + lastPeriod + 1;
        } else if (lastNewline !== -1) {
          end = end - Math.floor(chunkSize * 0.2) + lastNewline + 1;
        } else if (lastSpace !== -1) {
          end = end - Math.floor(chunkSize * 0.2) + lastSpace + 1;
        }
      }

      const chunkContent = content.substring(start, end).trim();

      if (chunkContent.length > 0) {
        chunks.push({
          chunkId: randomUUID(),
          docId,
          tenantId: payload.tenantId,
          projectId: payload.projectId,
          content: chunkContent,
          chunkIndex,
          metadata: {
            title: payload.title,
            ...payload.metadata,
          },
        });
        chunkIndex++;
      }

      start = end - overlap;
      if (start >= content.length || end === content.length) {
        break;
      }
      if (start < 0) {
        start = 0;
      }
    }

    return chunks;
  }
}
