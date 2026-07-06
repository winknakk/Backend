import * as fs from "fs";
import * as path from "path";
import { CacheService } from "../cache/CacheService";

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

interface CachedPrompt extends PromptRecord {
  mtimeMs: number;
}

export class PromptRegistry {
  private cache = new Map<string, CachedPrompt>();
  private promptDir: string;

  constructor(promptDir = path.join(process.cwd(), "prompts")) {
    this.promptDir = promptDir;
  }

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
You are operating strictly under the scope of Project ${activeProjectId}. You are authorized to run the following MCP tools: ${allowedTools.join(", ")}. Any other tools are strictly unauthorized and blocked by the platform security policy engine.`;

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

  clearCache(): void {
    this.cache.clear();
  }

  private loadPrompt(name: string): CachedPrompt {
    const filePath = this.resolvePromptPath(name);
    const stat = fs.statSync(filePath);
    const cached = this.cache.get(name);

    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    let version = "1";
    let template = raw;

    if (filePath.endsWith(".json")) {
      const parsed = JSON.parse(raw);
      version = String(parsed.version || version);
      template = String(parsed.template || "");
    }

    const record: CachedPrompt = {
      metadata: {
        name,
        version,
        filePath,
        loadedAt: new Date().toISOString(),
      },
      template,
      mtimeMs: stat.mtimeMs,
    };

    this.cache.set(name, record);
    return record;
  }

  private resolvePromptPath(name: string): string {
    const candidates = [
      path.join(this.promptDir, `${name}.json`),
      path.join(this.promptDir, `${name}.prompt`),
      path.join(this.promptDir, `${name}.txt`),
    ];
    const match = candidates.find((candidate) => fs.existsSync(candidate));
    if (!match) {
      throw new Error(`Prompt '${name}' was not found in ${this.promptDir}.`);
    }
    return match;
  }

  private interpolate(template: string, variables: Record<string, any>): string {
    return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) => {
      const value = variables[key];
      return value === undefined || value === null ? "" : String(value);
    });
  }
}
