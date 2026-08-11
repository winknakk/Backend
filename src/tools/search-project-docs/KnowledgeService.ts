import { DatabaseAdapter } from "../../adapters/types";
import { KnowledgeResult } from "../../schemas/validation";
import { IRetriever } from "../../rag/types";
import { KeywordRetriever } from "../../rag/KeywordRetriever";
import { pool } from "../../adapters/postgres/PostgresAdapter";

export interface CodeEvidenceResult {
  filePath: string;
  symbolName?: string;
  symbolType?: string;
  lineStart?: number;
  lineEnd?: number;
  language?: string;
  snippet: string;
  repositoryId: string;
  branch?: string;
  commitSha?: string;
}

export class KnowledgeService {
  private retriever: IRetriever;

  constructor(dbAdapter: DatabaseAdapter, retriever?: IRetriever) {
    this.retriever = retriever || new KeywordRetriever(dbAdapter);
  }

  /**
   * Queries retriever directly with tenant-aware scoping.
   */
  async searchProjects(query: string, filters?: { projectId?: string; orgId?: string; tenantId?: string }): Promise<KnowledgeResult[]> {
    return this.retriever.retrieve(query, filters);
  }

  /**
   * Preserves exact API compatibility for tools calling searchKnowledgeBase with optional orgId.
   */
  async searchKnowledgeBase(query: string, projectId?: string, orgId?: string): Promise<KnowledgeResult[]> {
    return this.retriever.retrieve(query, { projectId, orgId, tenantId: orgId });
  }

  /**
   * Performs tenant and project isolated code search against indexed code knowledge.
   * Returns exact code evidence with file path, line numbers, commit SHA, and snippet.
   */
  async searchCodebase(
    query: string,
    filters: {
      orgId: string;
      projectId: string | number;
      path?: string;
      language?: string;
      symbolType?: string;
      limit?: number;
    }
  ): Promise<CodeEvidenceResult[]> {
    const orgId = (filters.orgId || "").trim();
    const projectIdStr = String(filters.projectId || "").trim();

    // FAIL CLOSED: Missing orgId or projectId is strictly prohibited
    if (!orgId) {
      throw new Error("Security Violation: Tenant Context (orgId) is mandatory for searchCodebase");
    }
    if (!projectIdStr) {
      throw new Error("Security Violation: Project Context (projectId) is mandatory for searchCodebase");
    }

    const maxLimit = Math.min(Math.max(1, filters.limit || 10), 20); // Hard limit <= 20
    const queryTerm = (query || "").trim();

    if (!queryTerm) return [];

    try {
      const sqlParams: any[] = [orgId, projectIdStr, `%${queryTerm}%`];
      const sqlConditions: string[] = [
        "metadata->>'type' = 'code_symbol'",
        "metadata->>'orgId' = $1",
        "(metadata->>'projectId' = $2 OR metadata->>'project_id' = $2)",
        "(content ILIKE $3 OR metadata::text ILIKE $3)",
      ];

      if (filters.path) {
        sqlParams.push(`%${filters.path}%`);
        sqlConditions.push(`metadata->>'filePath' ILIKE $${sqlParams.length}`);
      }

      if (filters.language) {
        sqlParams.push(filters.language.toLowerCase());
        sqlConditions.push(`LOWER(metadata->>'language') = $${sqlParams.length}`);
      }

      sqlParams.push(maxLimit);

      const sqlQuery = `
        SELECT doc_id, content, metadata
        FROM document_embeddings
        WHERE ${sqlConditions.join(" AND ")}
        ORDER BY updated_at DESC
        LIMIT $${sqlParams.length};
      `;

      const { rows } = await pool.query(sqlQuery, sqlParams);

      return rows.map((row: any) => {
        const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata || {});
        const symbols = Array.isArray(meta.symbols) ? meta.symbols : [];
        const matchedSymbol = symbols.find((s: any) =>
          String(s.symbolName || "").toLowerCase().includes(queryTerm.toLowerCase())
        );

        const snippetLines = (row.content || "").split("\n");
        const previewSnippet = snippetLines.slice(0, 15).join("\n");

        return {
          filePath: meta.filePath || "unknown",
          symbolName: matchedSymbol?.symbolName || meta.filePath,
          symbolType: matchedSymbol?.symbolType || "code",
          lineStart: matchedSymbol?.lineStart || 1,
          lineEnd: matchedSymbol?.lineEnd || snippetLines.length,
          language: meta.language || "text",
          snippet: previewSnippet,
          repositoryId: String(meta.repoId || ""),
          branch: meta.branch || "main",
          commitSha: meta.commitSha || undefined,
        };
      });
    } catch (err: any) {
      console.error("[KnowledgeService] searchCodebase query error:", err.message);
      return [];
    }
  }
}
