import * as fs from "fs";
import * as path from "path";
import { IPolicyEngine, PolicyContext, PolicyAuthorizationResponse } from "./types";
import { PolicyRule, PolicyRuleSchema } from "../schemas/validation";
import { IToolRegistry } from "../tools/types";
import { config } from "../config/env";

import { CacheService } from "../cache/CacheService";

export class PolicyEngine implements IPolicyEngine {
  private rules: PolicyRule[] = [];
  private toolRegistry: IToolRegistry;
  private policySourceAvailable = false;

  constructor(toolRegistry: IToolRegistry, policyFilePath: string | undefined = config.POLICY_FILE_PATH) {
    this.toolRegistry = toolRegistry;
    this.loadPolicyFile(policyFilePath);
  }

  registerRule(rule: PolicyRule): void {
    this.rules.push(rule);
    this.policySourceAvailable = true;
  }

  loadPolicyFile(policyFilePath?: string): void {
    if (!policyFilePath) {
      return;
    }

    const resolved = path.isAbsolute(policyFilePath) ? policyFilePath : path.join(process.cwd(), policyFilePath);

    if (!fs.existsSync(resolved)) {
      this.policySourceAvailable = false;
      return;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(resolved, "utf-8"));
      const rawRules = Array.isArray(parsed) ? parsed : parsed.rules;
      if (!Array.isArray(rawRules)) {
        this.policySourceAvailable = false;
        return;
      }

      this.rules = rawRules.map((rule) => PolicyRuleSchema.parse(rule));
      this.policySourceAvailable = this.rules.length > 0;
    } catch {
      this.policySourceAvailable = false;
    }
  }

  async authorizeToolCall(
    toolName: string,
    params: Record<string, any>,
    context: PolicyContext
  ): Promise<PolicyAuthorizationResponse> {
    const tool = this.toolRegistry.getTool(toolName);
    if (!tool) {
      return {
        isAllowed: false,
        reason: `Tool '${toolName}' is not registered.`,
      };
    }

    let activeRules = this.rules;

    const agentId = context.agentId;
    if (agentId) {
      const companyId = context.companyId || "default-company";
      const cacheKey = `tenant:${companyId}:policy:${agentId}`;

      let cachedRules = await CacheService.getInstance().get<PolicyRule[]>(cacheKey);

      if (!cachedRules) {
        const policyDir = path.resolve(process.cwd(), "agent-policies");
        const filePath = path.join(policyDir, `${agentId}.json`);

        if (!fs.existsSync(filePath)) {
          return {
            isAllowed: false,
            reason: `Missing policy file for agent '${agentId}' at agent-policies/${agentId}.json. Strict default deny.`,
          };
        }

        try {
          const raw = fs.readFileSync(filePath, "utf-8");
          const parsed = JSON.parse(raw);
          const rawRules = Array.isArray(parsed) ? parsed : parsed.rules;
          if (!Array.isArray(rawRules)) {
            return {
              isAllowed: false,
              reason: `Invalid policy format for agent '${agentId}'.`,
            };
          }
          cachedRules = rawRules.map((rule) => PolicyRuleSchema.parse(rule));
          await CacheService.getInstance().set(cacheKey, cachedRules, 300);
        } catch (err: any) {
          return {
            isAllowed: false,
            reason: `Failed to load policy for agent '${agentId}': ${err.message}`,
          };
        }
      }
      activeRules = cachedRules || [];
    }

    if (!activeRules || activeRules.length === 0) {
      return {
        isAllowed: false,
        reason: `No policy rules are loaded; strict default deny blocked '${toolName}' for tenant ${context.companyId}.`,
      };
    }

    const matchingRules = activeRules.filter((r) => r.mcpToolNames.includes(toolName));
    if (matchingRules.some((r) => r.action === "deny")) {
      return {
        isAllowed: false,
        reason: `Access to tool '${toolName}' denied by security policies for tenant ${context.companyId}.`,
      };
    }

    const isAllowedByRules = matchingRules.some((r) => r.action === "allow");
    if (!isAllowedByRules) {
      return {
        isAllowed: false,
        reason: `No allow policy matched tool '${toolName}' for tenant ${context.companyId}.`,
      };
    }

    const parsed = tool.inputSchema.safeParse(params);
    if (!parsed.success) {
      return {
        isAllowed: false,
        reason: `Input validation failed: ${parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`,
      };
    }

    return {
      isAllowed: true,
      sanitizedParams: parsed.data,
    };
  }

  async sanitizeInputText(text: string): Promise<string> {
    let sanitized = text;
    sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
    sanitized = sanitized.replace(/UNION\s+SELECT/gi, "[REDACTED_SQL]");
    return sanitized;
  }

  async sanitizeOutputText(text: string): Promise<string> {
    return text.replace(/nc_pat_[a-zA-Z0-9]+/g, "[REDACTED_TOKEN]");
  }
}
