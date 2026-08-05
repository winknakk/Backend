import { pool } from "../adapters/postgres/PostgresAdapter";
import { TenantContext } from "../domain/tenant/TenantContext";
import { createLogger } from "../observability/logger";

const logger = createLogger("OrganizationPromptService");

export interface OrganizationPromptConfig {
  orgId: string;
  customPersonaPrompt?: string;
  supportTone?: string;
  autoEscalationRule?: string;
}

export class OrganizationPromptService {
  private cache = new Map<string, OrganizationPromptConfig>();

  async getPromptConfigForTenant(tenantCtx: TenantContext): Promise<OrganizationPromptConfig> {
    const orgId = tenantCtx.orgId || "org_default";

    if (this.cache.has(orgId)) {
      return this.cache.get(orgId)!;
    }

    try {
      const res = await pool.query(
        `SELECT id, name, slug FROM organizations WHERE id = $1 LIMIT 1`,
        [orgId]
      );

      const config: OrganizationPromptConfig = {
        orgId,
        customPersonaPrompt: `You are an AI Support Assistant for Organization ${res.rows[0]?.name || orgId}. Provide polite, accurate, multi-tenant scoped customer support.`,
        supportTone: "professional",
      };

      this.cache.set(orgId, config);
      return config;
    } catch (err: any) {
      logger.warn({ orgId, error: err.message }, "Fallback to default prompt config for tenant");
      return {
        orgId,
        customPersonaPrompt: "You are a professional multi-tenant AI Support Assistant.",
        supportTone: "professional",
      };
    }
  }

  clearCache(orgId?: string): void {
    if (orgId) {
      this.cache.delete(orgId);
    } else {
      this.cache.clear();
    }
  }
}
