import axios from "axios";
import { randomUUID } from "crypto";
import { DatabaseAdapter } from "../adapters/types";
import { TicketInput, ExecutionResult, SessionContext, CompanyContext, AuditLog } from "../schemas/validation";

export class NocoDBAdapter implements DatabaseAdapter {
  private apiToken: string | undefined;
  private baseUrl: string;
  private isProduction: boolean;

  constructor() {
    this.apiToken = process.env.NOCODB_TOKEN || process.env.NOCODB_API_TOKEN;
    this.baseUrl = process.env.NOCODB_BASE_URL || "https://app.nocodb.com";
    this.isProduction = process.env.NODE_ENV === "production";
  }

  async createTicket(input: TicketInput, slaDueDate: string, ticketNumber: string): Promise<ExecutionResult> {
    const executionId = randomUUID();
    const ticketData = {
      ticketId: ticketNumber,
      conversationId: input.conversationId,
      subject: input.subject,
      summary: input.summary,
      severity: input.severity,
      priority: input.priority,
      projectId: input.projectId,
      status: "Open",
      startDate: new Date().toISOString(),
      dueDate: slaDueDate,
      createdBy: "AI Support Agent"
    };

    try {
      if (!this.apiToken) {
        throw new Error("NocoDB API token is missing.");
      }

      const tableId = "t_tickets";
      const response = await axios.post(
        `${this.baseUrl}/api/v1/db/data/v1/pf7h6to5sqv2zed/${tableId}`,
        ticketData,
        {
          headers: {
            "xc-token": this.apiToken,
            "Content-Type": "application/json"
          },
          timeout: 2000
        }
      );

      return {
        success: true,
        data: response.data,
        error: null,
        source: "nocodb_live",
        executionId
      };

    } catch (e: any) {
      const errorMsg = e instanceof Error ? e.message : String(e);

      if (this.isProduction) {
        return {
          success: false,
          data: null,
          error: `NocoDB Connection Failure: ${errorMsg}`,
          source: "nocodb_live",
          executionId
        };
      } else {
        console.warn(`[NocoDBAdapter] Development Fallback: NocoDB is offline (${errorMsg}). Mocking ticket creation.`);
        return {
          success: true,
          data: ticketData,
          error: null,
          source: "nocodb_mock",
          executionId
        };
      }
    }
  }

  async findProject(projectId: string): Promise<any> {
    return { id1: projectId, name: "NocoDB Project", company_id: "1" };
  }

  async getConversation(conversationId: string): Promise<any> {
    return { id1: conversationId, status: "open", handled_by: "ai" };
  }

  async saveMessage(conversationId: string, role: string, content: string): Promise<any> {
    const messageData = {
      conversation_id: conversationId,
      role,
      content,
      created_at: new Date().toISOString(),
      conversation: conversationId
    };

    try {
      if (!this.apiToken) {
        throw new Error("NocoDB API token is missing.");
      }
      const response = await axios.post(
        `${this.baseUrl}/api/v1/db/data/v1/pf7h6to5sqv2zed/t_messages`,
        messageData,
        {
          headers: {
            "xc-token": this.apiToken,
            "Content-Type": "application/json"
          },
          timeout: 5000
        }
      );
      return response.data;
    } catch (e: any) {
      const errorMsg = e.response?.data?.message || e.message || String(e);
      console.error(`[NocoDBAdapter] saveMessage failed: ${errorMsg}`);
      if (this.isProduction) {
        throw e;
      }
      return { id1: "mock-msg-id", ...messageData };
    }
  }

  async ensureConversation(senderId: string, companyId: string, channel: string): Promise<string> {
    return `conv_${senderId}`;
  }

  async loadSessionContext(senderId: string, channel: string): Promise<SessionContext> {
    const companyContext: CompanyContext = {
      companyId: "1",
      companyName: "Orbit Retail Co., Ltd.",
      status: "Active" as const,
      aiPromptTemplate: `คุณคือ Support Agent AI สำหรับช่วยเหลือผู้ใช้ระบบ IT ของ Orbit Retail`,
      projects: [{ projectId: "1", projectName: "Orbit POS System", projectType: "Support" }],
      slaConfig: [{ projectId: "1", severity: "High", responseTimeHours: 4, resolveTimeHours: 12 }]
    };

    return {
      sessionId: `sess_conv_${senderId}`,
      companyId: "1",
      conversationId: `conv_${senderId}`,
      customerRef: senderId,
      companyContext,
      status: "open",
      handledBy: "ai"
    };
  }

  async getConversationHistory(conversationId: string, limit?: number): Promise<any[]> {
    return [];
  }

  async updateHandoffState(conversationId: string, handledBy: "ai" | "human"): Promise<void> {
    console.log(`[NocoDBAdapter] Updated handoff state for ${conversationId} to ${handledBy}`);
  }

  async searchKnowledge(query: string, filters?: { projectId?: string }): Promise<any[]> {
    // Return empty results in mock mode
    return [];
  }

  async saveTrace(trace: AuditLog): Promise<void> {
    try {
      if (!this.apiToken) {
        throw new Error("NocoDB API token is missing.");
      }
      await axios.post(
        `${this.baseUrl}/api/v1/db/data/v1/pf7h6to5sqv2zed/t_traces`,
        trace,
        {
          headers: {
            "xc-token": this.apiToken,
            "Content-Type": "application/json"
          },
          timeout: 5000
        }
      );
    } catch (e: any) {
      const errorMsg = e.response?.data?.message || e.message || String(e);
      console.error(`[NocoDBAdapter] saveTrace failed: ${errorMsg}`);
      if (this.isProduction) {
        throw e;
      }
    }
  }

  async getTrace(traceId: string): Promise<AuditLog | null> {
    try {
      if (!this.apiToken) {
        throw new Error("NocoDB API token is missing.");
      }
      const response = await axios.get(
        `${this.baseUrl}/api/v1/db/data/v1/pf7h6to5sqv2zed/t_traces/${traceId}`,
        {
          headers: {
            "xc-token": this.apiToken
          },
          timeout: 5000
        }
      );
      return response.data;
    } catch (e: any) {
      const errorMsg = e.response?.data?.message || e.message || String(e);
      console.error(`[NocoDBAdapter] getTrace failed: ${errorMsg}`);
      if (this.isProduction) {
        throw e;
      }
      return null;
    }
  }

  async listTraces(sessionId: string): Promise<AuditLog[]> {
    try {
      if (!this.apiToken) {
        throw new Error("NocoDB API token is missing.");
      }
      const response = await axios.get(
        `${this.baseUrl}/api/v1/db/data/v1/pf7h6to5sqv2zed/t_traces`,
        {
          headers: {
            "xc-token": this.apiToken
          },
          params: {
            where: `(sessionId,eq,${sessionId})`
          },
          timeout: 5000
        }
      );
      return response.data?.list || response.data || [];
    } catch (e: any) {
      const errorMsg = e.response?.data?.message || e.message || String(e);
      console.error(`[NocoDBAdapter] listTraces failed: ${errorMsg}`);
      if (this.isProduction) {
        throw e;
      }
      return [];
    }
  }
}
