import { IEmbeddingService } from "./types";
import { config } from "../config/env";
import axios from "axios";

export class EmbeddingService implements IEmbeddingService {
  async embedQuery(text: string): Promise<number[]> {
    if (config.EMBEDDING_PROVIDER === "external") {
      try {
        const apiKey = process.env.OPENAI_API_KEY || process.env.EMBEDDING_API_KEY;
        const apiUrl = process.env.EMBEDDING_API_URL || "https://api.openai.com/v1/embeddings";
        if (apiKey) {
          const response = await axios.post(
            apiUrl,
            {
              input: text,
              model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
            },
            {
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              timeout: 5000,
            }
          );
          if (response.status === 200 && response.data?.data?.[0]?.embedding) {
            return response.data.data[0].embedding;
          }
        }
      } catch (err: any) {
        console.warn("External embedding query failed, falling back to mock:", err.message || err);
      }
    }
    return this.getMockEmbedding(text);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (config.EMBEDDING_PROVIDER === "external") {
      try {
        const apiKey = process.env.OPENAI_API_KEY || process.env.EMBEDDING_API_KEY;
        const apiUrl = process.env.EMBEDDING_API_URL || "https://api.openai.com/v1/embeddings";
        if (apiKey) {
          const response = await axios.post(
            apiUrl,
            {
              input: texts,
              model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
            },
            {
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              timeout: 10000,
            }
          );
          if (response.status === 200 && Array.isArray(response.data?.data)) {
            const sorted = [...response.data.data].sort((a: any, b: any) => a.index - b.index);
            return sorted.map((d: any) => d.embedding);
          }
        }
      } catch (err: any) {
        console.warn("External embedding documents failed, falling back to mock:", err.message || err);
      }
    }
    return Promise.all(texts.map((t) => Promise.resolve(this.getMockEmbedding(t))));
  }

  private getMockEmbedding(text: string): number[] {
    const embedding: number[] = new Array(1536);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0; // Convert to 32bit integer
    }
    let seed = Math.abs(hash) || 1;
    for (let i = 0; i < 1536; i++) {
      seed = (seed * 9301 + 49297) % 233280;
      embedding[i] = seed / 233280.0;
    }

    // Normalize vector
    let sumSq = 0;
    for (let i = 0; i < 1536; i++) {
      sumSq += embedding[i] * embedding[i];
    }
    const magnitude = Math.sqrt(sumSq);
    if (magnitude > 0) {
      for (let i = 0; i < 1536; i++) {
        embedding[i] /= magnitude;
      }
    }
    return embedding;
  }
}
