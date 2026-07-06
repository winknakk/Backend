import { pool } from "../adapters/postgres/PostgresAdapter";
import { CacheService } from "../cache/CacheService";
import { createLogger } from "../observability/logger";
import { PromptConfig, SlaPolicy, RoutingRules } from "../domain/repositories/IConfigurationRepository";

const logger = createLogger("ConfigLoaderService");

export interface AiSettings {
  confidenceThreshold: number;
  maxHandoffDepth: number;
  vectorMatchThreshold: number;
}

export class ConfigLoaderService {
  private static instance: ConfigLoaderService;
  private cache: CacheService;

  private constructor() {
    this.cache = CacheService.getInstance();
  }

  static getInstance(): ConfigLoaderService {
    if (!ConfigLoaderService.instance) {
      ConfigLoaderService.instance = new ConfigLoaderService();
    }
    return ConfigLoaderService.instance;
  }

  /**
   * Retrieves prompt settings scoped to a specific project.
   */
  async getPromptConfig(projectId: string): Promise<PromptConfig> {
    const cacheKey = `config:project:${projectId}:prompt`;
    const cached = await this.cache.get<PromptConfig>(cacheKey);
    if (cached) return cached;

    logger.info({ projectId }, "Cache miss: loading project prompt config from DB");
    const { rows } = await pool.query(
      `SELECT system_instruction, model_name, temperature, max_tokens 
       FROM project_prompts 
       WHERE project_id = $1 
       LIMIT 1`,
      [projectId]
    );

    const config: PromptConfig = rows.length > 0 ? {
      systemInstruction: rows[0].system_instruction,
      modelName: rows[0].model_name,
      temperature: parseFloat(rows[0].temperature),
      maxTokens: rows[0].max_tokens
    } : {
      // System defaults if no database config exists
      systemInstruction: "You are an helpful AI Assistant designed to resolve tickets and support customers.",
      modelName: "gemini-1.5-pro",
      temperature: 0.00,
      maxTokens: 2048
    };

    await this.cache.set(cacheKey, config, 3600); // cache for 1 hour
    return config;
  }

  /**
   * Retrieves SLA policies mapped to a specific project.
   */
  async getSlaPolicy(projectId: string): Promise<SlaPolicy> {
    const cacheKey = `config:project:${projectId}:sla`;
    const cached = await this.cache.get<SlaPolicy>(cacheKey);
    if (cached) return cached;

    logger.info({ projectId }, "Cache miss: loading project SLA policy from DB");
    const { rows } = await pool.query(
      `SELECT priority, resolve_hours 
       FROM project_sla_policies 
       WHERE project_id = $1`,
      [projectId]
    );

    const policies = rows.map(r => ({
      priority: r.priority,
      resolveHours: r.resolve_hours
    }));

    const config: SlaPolicy = { policies };
    await this.cache.set(cacheKey, config, 3600);
    return config;
  }

  /**
   * Retrieves routing rules mapped to a specific project.
   */
  async getRoutingRules(projectId: string): Promise<RoutingRules> {
    const cacheKey = `config:project:${projectId}:routing`;
    const cached = await this.cache.get<RoutingRules>(cacheKey);
    if (cached) return cached;

    logger.info({ projectId }, "Cache miss: loading project routing rules from DB");
    const { rows } = await pool.query(
      `SELECT rule_type, conditions, target_handler 
       FROM project_routing_rules 
       WHERE project_id = $1`,
      [projectId]
    );

    const rules = rows.map(r => ({
      ruleType: r.rule_type,
      conditions: r.conditions,
      targetHandler: r.target_handler
    }));

    const config: RoutingRules = { rules };
    await this.cache.set(cacheKey, config, 3600);
    return config;
  }

  /**
   * Retrieves AI Settings mapped to a specific project.
   */
  async getAiSettings(projectId: string): Promise<AiSettings> {
    const cacheKey = `config:project:${projectId}:ai_settings`;
    const cached = await this.cache.get<AiSettings>(cacheKey);
    if (cached) return cached;

    logger.info({ projectId }, "Cache miss: loading project AI settings from DB");
    const { rows } = await pool.query(
      `SELECT confidence_threshold, max_handoff_depth, vector_match_threshold 
       FROM project_ai_settings 
       WHERE project_id = $1 
       LIMIT 1`,
      [projectId]
    );

    const config: AiSettings = rows.length > 0 ? {
      confidenceThreshold: parseFloat(rows[0].confidence_threshold),
      maxHandoffDepth: rows[0].max_handoff_depth,
      vectorMatchThreshold: parseFloat(rows[0].vector_match_threshold)
    } : {
      confidenceThreshold: 0.70,
      maxHandoffDepth: 5,
      vectorMatchThreshold: 0.60
    };

    await this.cache.set(cacheKey, config, 3600);
    return config;
  }

  /**
   * Resolves a project's feature flag value dynamically.
   */
  async getFeatureFlag(projectId: string, flagName: string): Promise<boolean> {
    const cacheKey = `config:project:${projectId}:flag:${flagName}`;
    const cached = await this.cache.get<boolean>(cacheKey);
    if (cached !== null) return cached;

    logger.info({ projectId, flagName }, "Cache miss: loading project feature flag from DB");
    const { rows } = await pool.query(
      `SELECT is_enabled 
       FROM project_feature_flags 
       WHERE project_id = $1 AND flag_name = $2 
       LIMIT 1`,
      [projectId, flagName]
    );

    const isEnabled = rows.length > 0 ? rows[0].is_enabled : false;
    await this.cache.set(cacheKey, isEnabled, 300); // short TTL for feature flags (5 minutes)
    return isEnabled;
  }

  /**
   * Invalidates all configurations cached for a specific project.
   */
  async invalidateProjectCache(projectId: string): Promise<void> {
    logger.info({ projectId }, "Invalidating cached configurations for project");
    await this.cache.delete(`config:project:${projectId}:prompt`);
    await this.cache.delete(`config:project:${projectId}:sla`);
    await this.cache.delete(`config:project:${projectId}:routing`);
    await this.cache.delete(`config:project:${projectId}:ai_settings`);
  }
}
