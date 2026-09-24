import { IEmbeddingService } from "./types";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";
import axios from "axios";

const logger = createLogger("EmbeddingService");

/**
 * Where a vector came from. A "mock" vector is a deterministic hash of the
 * text: it carries no semantic meaning and must never be presented as
 * semantic evidence.
 */
export type EmbeddingSource = "external" | "mock";

export type EmbeddingFallbackReason =
  | "provider_mock"
  | "api_key_missing"
  | "external_request_failed"
  | "external_response_invalid";

export interface DetailedEmbedding {
  vector: number[];
  source: EmbeddingSource;
  fallbackReason: EmbeddingFallbackReason | null;
}

export class EmbeddingService implements IEmbeddingService {
  async embedQuery(text: string): Promise<number[]> {
    return (await this.embedQueryDetailed(text)).vector;
  }

  /**
   * Same vector as embedQuery, plus its provenance. Callers that treat
   * similarity as evidence must use this and handle source === "mock".
   */
  async embedQueryDetailed(text: string): Promise<DetailedEmbedding> {
    if (config.EMBEDDING_PROVIDER !== "external") {
      return { vector: this.getMockEmbedding(text), source: "mock", fallbackReason: "provider_mock" };
    }

    const apiKey = process.env.OPENAI_API_KEY || process.env.EMBEDDING_API_KEY;
    if (!apiKey) {
      logger.warn({ reason: "api_key_missing" }, "EMBEDDING_PROVIDER=external but no embedding API key is set; using mock vectors");
      return { vector: this.getMockEmbedding(text), source: "mock", fallbackReason: "api_key_missing" };
    }

    try {
      const apiUrl = process.env.EMBEDDING_API_URL || "https://api.openai.com/v1/embeddings";
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
        return { vector: response.data.data[0].embedding, source: "external", fallbackReason: null };
      }
      logger.warn({ reason: "external_response_invalid", status: response.status }, "External embedding returned no vector; using mock vector");
      return { vector: this.getMockEmbedding(text), source: "mock", fallbackReason: "external_response_invalid" };
    } catch (err: any) {
      logger.warn(
        { reason: "external_request_failed", status: err?.response?.status ?? null, error: err?.message },
        "External embedding query failed; using mock vector"
      );
      return { vector: this.getMockEmbedding(text), source: "mock", fallbackReason: "external_request_failed" };
    }
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
          logger.warn({ reason: "external_response_invalid", status: response.status }, "External document embedding returned no vectors; using mock vectors");
        } else {
          logger.warn({ reason: "api_key_missing" }, "EMBEDDING_PROVIDER=external but no embedding API key is set; using mock vectors");
        }
      } catch (err: any) {
        logger.warn(
          { reason: "external_request_failed", status: err?.response?.status ?? null, error: err?.message, count: texts.length },
          "External document embedding failed; using mock vectors"
        );
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
