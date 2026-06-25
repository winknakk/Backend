import { z } from "zod";
import { ITool } from "../types";
import { McpToolDefinition } from "../../mcp/types";
import { KnowledgeResultSchema } from "../../schemas/validation";
import { KnowledgeService } from "./KnowledgeService";

export const SearchInputSchema = z.object({
  query: z.string().min(2, "Search query must be at least 2 characters"),
  projectId: z.string().optional()
});
export type SearchInput = z.infer<typeof SearchInputSchema>;

export const SearchOutputSchema = z.object({
  results: z.array(KnowledgeResultSchema)
});
export type SearchOutput = z.infer<typeof SearchOutputSchema>;

export class SearchProjectDocsTool implements ITool {
  readonly definition: McpToolDefinition = {
    name: "search_project_docs",
    description: "Search historical troubleshooting documents, past conversations, and resolved issues for standard solutions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text (e.g. error message, app crash)" },
        projectId: { type: "string", description: "Optional project ID to filter searches" }
      },
      required: ["query"]
    }
  };

  readonly inputSchema = SearchInputSchema;
  readonly outputSchema = SearchOutputSchema;

  private knowledgeService: KnowledgeService;

  constructor(knowledgeService: KnowledgeService) {
    this.knowledgeService = knowledgeService;
  }

  async execute(params: Record<string, any>): Promise<Record<string, any>> {
    const input = SearchInputSchema.parse(params);
    const results = await this.knowledgeService.searchKnowledgeBase(input.query, input.projectId);
    return SearchOutputSchema.parse({ results });
  }
}
