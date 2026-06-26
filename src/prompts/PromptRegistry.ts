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
    const tId = tenantId || "global";
    const ver = version || "default";
    const cacheKey = `tenant:${tId}:prompt:${name}:${ver}`;

    let record = await CacheService.getInstance().get<PromptRecord>(cacheKey);

    if (!record) {
      let loaded: CachedPrompt;
      if (version && version !== "default") {
        try {
          loaded = this.loadPrompt(`${version}/${name}`);
        } catch {
          loaded = this.loadPrompt(name);
        }
      } else {
        loaded = this.loadPrompt(name);
      }
      record = {
        metadata: loaded.metadata,
        template: loaded.template,
      };

      await CacheService.getInstance().set(cacheKey, record, 300);
    }

    return {
      metadata: record.metadata,
      template: this.interpolate(record.template, variables),
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
