export interface PromptConfig {
  systemInstruction: string;
  modelName: string;
  temperature: number;
  maxTokens: number;
}

export interface SlaPolicy {
  policies: Array<{
    priority: string;
    resolveHours: number;
  }>;
}

export interface RoutingRules {
  rules: Array<{
    ruleType: string;
    conditions: Record<string, any>;
    targetHandler: string;
  }>;
}

export interface IConfigurationRepository {
  /**
   * Retrieves prompt settings scoped to a specific project.
   */
  getPromptConfig(projectId: string): Promise<PromptConfig | null>;

  /**
   * Retrieves SLA policies mapped to a specific project.
   */
  getSlaPolicy(projectId: string): Promise<SlaPolicy | null>;

  /**
   * Retrieves routing rules mapped to a specific project.
   */
  getRoutingRules(projectId: string): Promise<RoutingRules | null>;
}
