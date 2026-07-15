import { z } from "zod";
import { ITool } from "../types";
import { McpToolDefinition } from "../../mcp/types";
import { KnowledgeResultSchema, ExecutionResultSchema } from "../../schemas/validation";
import { KnowledgeService } from "./KnowledgeService";

export const SearchInputSchema = z.object({
  query: z.string().min(2, "Search query must be at least 2 characters"),
  projectId: z.string().optional(),
});
export type SearchInput = z.infer<typeof SearchInputSchema>;

export const SearchOutputSchema = z.object({
  results: z.array(KnowledgeResultSchema),
});
export type SearchOutput = z.infer<typeof SearchOutputSchema>;

export class SearchProjectDocsTool implements ITool {
  definition!: McpToolDefinition;
  readonly name = "search_project_docs";

  readonly inputSchema = SearchInputSchema;
  readonly outputSchema = ExecutionResultSchema;

  private knowledgeService: KnowledgeService;

  constructor(knowledgeService: KnowledgeService) {
    this.knowledgeService = knowledgeService;
  }

  async execute(params: Record<string, any>, context?: any): Promise<Record<string, any>> {
    const input = SearchInputSchema.parse(params);
    const results = await this.knowledgeService.searchKnowledgeBase(input.query, input.projectId);
    
    // Normalize to standardized execution wrapper
    return {
      success: true,
      data: { results },
      error: null,
      source: "postgres",
      executionId: require("crypto").randomUUID(),
    };
  }
}
