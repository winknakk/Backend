import { CompanyContext } from "../memory/types";

export interface ITenantService {
  /**
   * Retrieves the project list, SLA thresholds, and prompt templates for a specific client company.
   */
  getTenantConfig(companyId: string): Promise<CompanyContext>;
}
