import { z } from "zod";
import { ITool } from "./types";
import { McpToolDefinition } from "../mcp/types";
import { ExecutionResultSchema } from "../schemas/validation";
import { KnowledgeService, CodeEvidenceResult } from "./search-project-docs/KnowledgeService";

export const SearchCodebaseInputSchema = z.object({
  query: z.string().min(1, "Search query is required"),
  projectId: z.string().min(1, "ProjectId is required"),
  path: z.string().optional(),
  language: z.string().optional(),
  symbolType: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(10),
});
export type SearchCodebaseInput = z.infer<typeof SearchCodebaseInputSchema>;

export const SearchCodebaseOutputSchema = z.object({
  evidence: z.array(
    z.object({
      filePath: z.string(),
      symbolName: z.string().optional(),
      symbolType: z.string().optional(),
      lineStart: z.number().optional(),
      lineEnd: z.number().optional(),
      language: z.string().optional(),
      snippet: z.string(),
      repositoryId: z.string(),
      branch: z.string().optional(),
      commitSha: z.string().optional(),
    })
  ),
});
export type SearchCodebaseOutput = z.infer<typeof SearchCodebaseOutputSchema>;

export class SearchCodebaseTool implements ITool {
  definition!: McpToolDefinition;
  readonly name = "search_codebase";

  readonly inputSchema = SearchCodebaseInputSchema;
  readonly outputSchema = ExecutionResultSchema;

  private knowledgeService: KnowledgeService;

  constructor(knowledgeService: KnowledgeService) {
    this.knowledgeService = knowledgeService;
  }

  async execute(params: Record<string, any>, context?: any): Promise<Record<string, any>> {
    const input = SearchCodebaseInputSchema.parse(params);

    // Authority on tenant context MUST come from server-managed context, never unvalidated input
    const orgId = (context?.orgId || context?.tenantId || context?.tenantContext?.orgId || "").trim();

    if (!orgId) {
      throw new Error("Security Violation: Tenant Context (orgId) is mandatory for search_codebase tool execution");
    }

    const evidence: CodeEvidenceResult[] = await this.knowledgeService.searchCodebase(input.query, {
      orgId,
      projectId: input.projectId,
      path: input.path,
      language: input.language,
      symbolType: input.symbolType,
      limit: input.limit,
    });

    return {
      success: true,
      data: { evidence },
      error: null,
      source: "postgres_codebase",
      executionId: require("crypto").randomUUID(),
    };
  }
}
