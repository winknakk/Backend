export interface PromptMetadata {
  name: string;
  version: string;
  filePath: string;
  loadedAt: string;
}

export interface PromptRecord {
  metadata: PromptMetadata;
  template: string;
}

export class PromptRegistry {
  async getPrompt(
    name: string,
    variables: Record<string, any> = {},
    version?: string,
    tenantId?: string
  ): Promise<PromptRecord> {
    const { getProjectId } = require("../kernel/context/RequestContextHolder");
    const activeProjectId = getProjectId() || tenantId || "1";

    const configLoader = require("../services/ConfigLoaderService").ConfigLoaderService.getInstance();
    const promptConfig = await configLoader.getPromptConfig(activeProjectId);

    let allowedTools: string[] = [];
    try {
      const { pool } = require("../adapters/postgres/PostgresAdapter");
      const { rows } = await pool.query(
        "SELECT tool_name FROM project_mcp_permissions WHERE project_id = $1::integer",
        [parseInt(activeProjectId)]
      );
      allowedTools = rows.map((r: any) => r.tool_name);
    } catch (dbErr: any) {
      console.warn(`[PromptRegistry] Failed to query permissions for project ${activeProjectId}:`, dbErr.message);
      allowedTools = ["search_project_docs", "create_ticket"];
    }

    const dynamicDirective = `

[System Project Context Scope]
Active Project ID: ${activeProjectId}
You are operating strictly under the scope of Project ${activeProjectId}. You can only view knowledge base documents and create/retrieve tickets that are bound to this active project scope. You are authorized to run the following MCP tools: ${allowedTools.join(", ")}. Any other tools are strictly unauthorized and blocked by the platform security policy engine.`;

    const rawTemplate = (promptConfig?.systemInstruction || "You are an helpful AI Assistant designed to resolve tickets and support customers.") + dynamicDirective;

    return {
      metadata: {
        name,
        version: promptConfig?.modelName || "gemini-1.5-pro",
        filePath: "database:project_prompts",
        loadedAt: new Date().toISOString(),
      },
      template: this.interpolate(rawTemplate, variables),
    };
  }

  private interpolate(template: string, variables: Record<string, any>): string {
    return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) => {
      const value = variables[key];
      return value === undefined || value === null ? "" : String(value);
    });
  }
}
