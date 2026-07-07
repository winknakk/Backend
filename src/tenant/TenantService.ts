import { ITenantService } from "./types";
import { CompanyContext } from "../memory/types";

export class TenantService implements ITenantService {
  private mockTenants: Record<string, CompanyContext> = {
    "1": {
      companyId: "1",
      companyName: "กสม",
      status: "Active",
      aiPromptTemplate: "คุณคือ Support Agent AI สำหรับช่วยเหลือผู้ใช้ระบบ SSO/AD ของ กสม.",
      projects: [{ projectId: "1", projectName: "SSO/AD System", projectType: "SSO / AD" }],
      slaConfig: [
        { projectId: "1", severity: "Critical", responseTimeHours: 1, resolveTimeHours: 4 },
        { projectId: "1", severity: "High", responseTimeHours: 4, resolveTimeHours: 12 },
        { projectId: "1", severity: "Medium", responseTimeHours: 24, resolveTimeHours: 48 },
        { projectId: "1", severity: "Low", responseTimeHours: 72, resolveTimeHours: 120 },
      ],
    },
    "2": {
      companyId: "2",
      companyName: "ราชวิ",
      status: "Active",
      aiPromptTemplate: "คุณคือ Support Agent AI สำหรับช่วยเหลือผู้ใช้ระบบ IT โรงพยาบาลราชวิถี",
      projects: [{ projectId: "2", projectName: "App Support", projectType: "Application Support" }],
      slaConfig: [
        { projectId: "2", severity: "Critical", responseTimeHours: 2, resolveTimeHours: 4 },
        { projectId: "2", severity: "High", responseTimeHours: 8, resolveTimeHours: 24 },
      ],
    },
  };

  async getTenantConfig(companyId: string): Promise<CompanyContext> {
    const config = this.mockTenants[companyId];
    if (!config) {
      throw new Error(`Tenant context not found for company ID: ${companyId}`);
    }
    return config;
  }
}
