import { IRetriever } from "./types";
import { DatabaseAdapter } from "../adapters/types";
import { KnowledgeResult } from "../schemas/validation";

export class KeywordRetriever implements IRetriever {
  private dbAdapter: DatabaseAdapter;

  constructor(dbAdapter: DatabaseAdapter) {
    this.dbAdapter = dbAdapter;
  }

  async retrieve(query: string, filters?: { projectId?: string }): Promise<KnowledgeResult[]> {
    const rawResults = await this.dbAdapter.searchKnowledge(query, filters);
    
    const results: KnowledgeResult[] = rawResults.map((raw) => {
      let confidence = raw.score || 0.5;

      // Adjust confidence based on context
      if (raw.type === "message") {
        const role = raw.metadata?.role;
        if (role === "ai" || role === "human" || role === "assistant" || role === "support") {
          confidence = Math.min(confidence * 1.2, 1.0);
        } else {
          confidence = confidence * 0.4;
        }
      } else if (raw.type === "ticket") {
        const status = raw.metadata?.status;
        if (status === "resolved" || status === "closed") {
          confidence = Math.min(confidence * 1.1, 1.0);
        } else {
          confidence = confidence * 0.3;
        }
      }

      // Cap confidence between 0.0 and 1.0
      confidence = Math.max(0.0, Math.min(1.0, parseFloat(confidence.toFixed(2))));

      return {
        source: process.env.DATABASE_PROVIDER || "local",
        id: String(raw.id),
        type: (raw.type as "ticket" | "message" | "document") || "document",
        content: raw.content || "",
        confidence,
        metadata: raw.metadata,
      };
    });

    return results.sort((a, b) => b.confidence - a.confidence);
  }
}
