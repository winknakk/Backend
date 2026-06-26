import * as fs from "fs";
import * as path from "path";
import { CacheService } from "../../cache/CacheService";
import { DatabaseAdapter } from "../types";
import {
  TicketInput,
  ExecutionResult,
  AuditLog,
  AuditLogSchema,
} from "../../schemas/validation";
import { SessionContext, CompanyContext } from "../../memory/types";
import {
  DbCompanySchema,
  DbIdentitySchema,
  DbProfileSchema,
  DbProjectSchema,
  DbConversationSchema,
  DbMessageSchema,
  DbTicketSchema,
} from "../../schemas/database.schema";
import { randomUUID } from "crypto";

export class LocalDataAdapter implements DatabaseAdapter {
  private getFilePath(tableName: string): string {
    const candidates = [
      path.resolve(__dirname, "../../../data"),
      path.resolve(process.cwd(), "data"),
      path.resolve(process.cwd(), "ticket_codebase/data"),
    ];

    let dataDir = candidates[0];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        const files = fs.readdirSync(cand);
        const hasData = files.some(
          (f) =>
            f.endsWith(".json") &&
            (f.includes("Tickets") || f.includes("Messages") || f.includes("Projects"))
        );
        if (hasData) {
          dataDir = cand;
          break;
        }
      }
    }

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const files = fs.readdirSync(dataDir);
    const match =
      files.find((f) => f.includes(`(${tableName})`) && f.endsWith(".json")) ||
      files.find((f) => f.includes(tableName) && f.endsWith(".json"));
    if (!match) {
      const defaultFilename = `Ticket V.2 - ${tableName} (${tableName}).json`;
      const filePath = path.join(dataDir, defaultFilename);
      fs.writeFileSync(filePath, "[]", "utf-8");
      return filePath;
    }
    return path.join(dataDir, match);
  }

  private readTable<T>(tableName: string, schema: any): T[] {
    const filePath = this.getFilePath(tableName);
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    return parsed.filter((row: any) => row.id1 !== null).map((row: any) => schema.parse(row)) as T[];
  }

  private writeTable<T>(tableName: string, data: T[]): void {
    const filePath = this.getFilePath(tableName);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async findProject(projectId: string): Promise<any> {
    const projects = this.readTable<any>("Projects", DbProjectSchema);
    return projects.find((p) => p.id1 === projectId);
  }

  async getConversation(conversationId: string): Promise<any> {
    const conversations = this.readTable<any>("Conversations", DbConversationSchema);
    return conversations.find((c) => c.id1 === conversationId);
  }

  async saveMessage(conversationId: string, role: string, content: string): Promise<any> {
    const messages = this.readTable<any>("Messages", DbMessageSchema);

    const maxId = messages.reduce((max, m) => {
      const id = parseInt(m.id1 || "0", 10);
      return id > max ? id : max;
    }, 0);

    const newMessage = {
      id1: String(maxId + 1),
      conversation_id: conversationId,
      role,
      content,
      created_at: new Date().toISOString(),
      conversation: conversationId,
    };

    messages.push(newMessage);
    this.writeTable("Messages", messages);
    return newMessage;
  }

  async createTicket(input: TicketInput, slaDueDate: string, ticketNumber: string): Promise<ExecutionResult> {
    const executionId = randomUUID();
    const tickets = this.readTable<any>("Tickets", DbTicketSchema);

    const maxId = tickets.reduce((max, t) => {
      const id = parseInt(t.id1 || "0", 10);
      return id > max ? id : max;
    }, 0);

    const newTicket = {
      id1: String(maxId + 1),
      ticket_id: ticketNumber,
      conversation_id: input.conversationId,
      subject: input.subject,
      summary: input.summary,
      status: "open",
      priority: input.priority === "P1" || input.priority === "P2" ? "urgent" : "normal",
      assigned_pm: "pm_lek",
      created_via: "ai",
      plane_issue_id: null,
      conversation: input.conversationId,
      severity: input.severity,
      due_date: slaDueDate,
    };

    tickets.push(newTicket);
    this.writeTable("Tickets", tickets);

    const ticketData = {
      ticketId: ticketNumber,
      conversationId: input.conversationId,
      subject: input.subject,
      summary: input.summary,
      severity: input.severity,
      priority: input.priority,
      projectId: input.projectId,
      status: "Open" as const,
      startDate: new Date().toISOString(),
      dueDate: slaDueDate,
      createdBy: "AI Support Agent",
    };

    return {
      success: true,
      data: ticketData,
      error: null,
      source: "local",
      executionId,
    };
  }

  async ensureConversation(senderId: string, companyId: string, channel: string): Promise<string> {
    const identities = this.readTable<any>("Identities", DbIdentitySchema);
    const conversations = this.readTable<any>("Conversations", DbConversationSchema);

    let identity = identities.find(
      (id) => id.channel_ref === senderId && id.channel?.toLowerCase() === channel.toLowerCase()
    );

    if (!identity) {
      const maxId = identities.reduce((max, id) => {
        const idVal = parseInt(id.id1 || "0", 10);
        return idVal > max ? idVal : max;
      }, 0);

      const profiles = this.readTable<any>("Profiles", DbProfileSchema);
      const profile = profiles.find((p) => p.company === companyId) || profiles[0];

      identity = {
        id1: String(maxId + 1),
        profile_id: profile.id1,
        channel: channel.toLowerCase(),
        channel_ref: senderId,
        profile: profile.id1,
        Conversations: "",
      };

      identities.push(identity);
      this.writeTable("Identities", identities);
    }

    let conversation = conversations.find((c) => c.identity_id === identity!.id1 && c.status === "open");

    if (!conversation) {
      const maxId = conversations.reduce((max, c) => {
        const idVal = parseInt(c.id1 || "0", 10);
        return idVal > max ? idVal : max;
      }, 0);

      const projects = this.readTable<any>("Projects", DbProjectSchema);
      const project = projects.find((p) => p.company_id === companyId) || projects[0];

      conversation = {
        id1: String(maxId + 1),
        identity_id: identity.id1,
        project_id: project.id1,
        channel: channel.toLowerCase(),
        status: "open",
        handled_by: "ai",
        assigned_pm: null,
        updated_at: new Date().toISOString(),
        identity: identity.id1,
        project: project.id1,
        Messages: "",
        Tickets: "",
      };

      conversations.push(conversation);
      this.writeTable("Conversations", conversations);
    }

    return conversation.id1!;
  }

  async loadSessionContext(senderId: string, channel: string): Promise<SessionContext> {
    const identities = this.readTable<any>("Identities", DbIdentitySchema);
    const profiles = this.readTable<any>("Profiles", DbProfileSchema);
    const companies = this.readTable<any>("Companies", DbCompanySchema);
    const projects = this.readTable<any>("Projects", DbProjectSchema);

    let identity = identities.find(
      (id) => id.channel_ref === senderId && id.channel?.toLowerCase() === channel.toLowerCase()
    );

    if (!identity) {
      const conversationId = await this.ensureConversation(senderId, "1", channel);
      identity = identities.find((id) => id.id1 === conversationId);
      if (!identity) {
        identity = identities[0];
      }
    }

    const profile = profiles.find((p) => p.id1 === identity!.profile_id) || profiles[0];

    const company = companies.find((c) => c.id1 === profile.company) || companies[0];
    const companyId = company.id1!;

    const cacheKey = `tenant:${companyId}:config`;
    let companyContext = await CacheService.getInstance().get<CompanyContext>(cacheKey);

    if (!companyContext) {
      const companyProjects = projects
        .filter((p) => p.company_id === companyId)
        .map((p) => ({
          projectId: p.id1!,
          projectName: p.name!,
          projectType: p.Companies || "Support",
        }));

      const slaConfig = companyProjects
        .map((p) => [
          { projectId: p.projectId, severity: "Critical", responseTimeHours: 1, resolveTimeHours: 4 },
          { projectId: p.projectId, severity: "High", responseTimeHours: 4, resolveTimeHours: 12 },
          { projectId: p.projectId, severity: "Medium", responseTimeHours: 24, resolveTimeHours: 48 },
          { projectId: p.projectId, severity: "Low", responseTimeHours: 72, resolveTimeHours: 120 },
        ])
        .flat();

      companyContext = {
        companyId,
        companyName: company.name || "Default Company",
        status: "Active" as const,
        aiPromptTemplate: `คุณคือ Support Agent AI สำหรับช่วยเหลือผู้ใช้ระบบ IT ของบริษัท ${company.name}`,
        projects: companyProjects,
        slaConfig,
      };
      await CacheService.getInstance().set(cacheKey, companyContext, 300);
    }

    const conversationId = await this.ensureConversation(senderId, companyId, channel);
    const conversation = await this.getConversation(conversationId);

    return {
      sessionId: `sess_${conversationId}`,
      companyId,
      conversationId,
      customerRef: senderId,
      companyContext,
      status: conversation.status || "open",
      handledBy: conversation.handled_by || "ai",
    };
  }

  async getConversationHistory(conversationId: string, limit: number = 10): Promise<any[]> {
    const messages = this.readTable<any>("Messages", DbMessageSchema);
    const filtered = messages
      .filter((m) => m.conversation_id === conversationId)
      .map((m) => ({
        role: m.role as "customer" | "ai" | "system",
        content: m.content || "",
        timestamp: m.created_at || new Date().toISOString(),
      }));
    return filtered.slice(-limit);
  }

  async updateHandoffState(conversationId: string, handledBy: "ai" | "human"): Promise<void> {
    const conversations = this.readTable<any>("Conversations", DbConversationSchema);
    const conv = conversations.find((c) => c.id1 === conversationId);
    if (conv) {
      conv.handled_by = handledBy;
      conv.status = handledBy === "human" ? "escalated" : "open";
      this.writeTable("Conversations", conversations);
    }
  }

  async searchKnowledge(query: string, filters?: { projectId?: string }): Promise<any[]> {
    const lowerQuery = query.toLowerCase();
    const queryWords = lowerQuery.split(/\s+/).filter((w) => w.length > 2);
    const matches: any[] = [];

    // 1. Search Messages (resolved answers by AI or human)
    try {
      const messages = this.readTable<any>("Messages", DbMessageSchema);
      const conversations = this.readTable<any>("Conversations", DbConversationSchema);

      messages.forEach((m) => {
        const content = m.content || "";
        const lowerContent = content.toLowerCase();

        // Find if this message belongs to the specified project (filter check)
        if (filters?.projectId) {
          const conv = conversations.find((c) => c.id1 === m.conversation_id);
          if (conv && conv.project_id !== filters.projectId) {
            return; // Skip if project doesn't match filter
          }
        }

        // Calculate simple keyword overlap
        let overlapCount = 0;
        if (queryWords.length > 0) {
          queryWords.forEach((word) => {
            if (lowerContent.includes(word)) overlapCount++;
          });
        } else if (lowerContent.includes(lowerQuery)) {
          overlapCount = 1;
        }

        if (overlapCount > 0) {
          const score = queryWords.length > 0 ? overlapCount / queryWords.length : 0.5;
          if (m.id1 === "6") {
            console.log(`[Debug Search] Message #6: content="${lowerContent}"`);
            console.log(`[Debug Search] queryWords=${JSON.stringify(queryWords)}`);
            console.log(`[Debug Search] overlapCount=${overlapCount}, score=${score}`);
          }
          matches.push({
            id: m.id1 || "msg-unknown",
            type: "message",
            content,
            score,
            metadata: {
              conversationId: m.conversation_id,
              role: m.role,
            },
          });
        }
      });
    } catch (e) {
      console.warn("[LocalDataAdapter] Failed reading Messages during search:", e);
    }

    // 2. Search Tickets (historical issues and descriptions)
    try {
      const tickets = this.readTable<any>("Tickets", DbTicketSchema);
      tickets.forEach((t) => {
        const subject = t.subject || "";
        const summary = t.summary || "";
        const textToSearch = `${subject} ${summary}`.toLowerCase();

        if (filters?.projectId) {
          // If conversation's project does not match, skip
          // For MVP local data, we check conversation link
        }

        let overlapCount = 0;
        if (queryWords.length > 0) {
          queryWords.forEach((word) => {
            if (textToSearch.includes(word)) overlapCount++;
          });
        } else if (textToSearch.includes(lowerQuery)) {
          overlapCount = 1;
        }

        if (overlapCount > 0) {
          const score = queryWords.length > 0 ? overlapCount / queryWords.length : 0.5;
          matches.push({
            id: t.id1 || "tck-unknown",
            type: "ticket",
            content: `Subject: ${subject}\nSummary: ${summary}`,
            score,
            metadata: {
              status: t.status,
              priority: t.priority,
              plane_issue_id: t.plane_issue_id,
            },
          });
        }
      });
    } catch (e) {
      console.warn("[LocalDataAdapter] Failed reading Tickets during search:", e);
    }

    // Sort by score descending
    return matches.sort((a, b) => b.score - a.score);
  }

  async saveTrace(trace: AuditLog): Promise<void> {
    const traces = this.readTable<AuditLog>("Traces", AuditLogSchema);
    const index = traces.findIndex((t) => t.traceId === trace.traceId);
    if (index !== -1) {
      traces[index] = trace;
    } else {
      traces.push(trace);
    }
    this.writeTable("Traces", traces);
  }

  async getTrace(traceId: string): Promise<AuditLog | null> {
    const traces = this.readTable<AuditLog>("Traces", AuditLogSchema);
    return traces.find((t) => t.traceId === traceId) || null;
  }

  async listTraces(sessionId: string): Promise<AuditLog[]> {
    const traces = this.readTable<AuditLog>("Traces", AuditLogSchema);
    return traces.filter((t) => t.sessionId === sessionId);
  }

  async listAllTraces(): Promise<AuditLog[]> {
    return this.readTable<AuditLog>("Traces", AuditLogSchema);
  }

  async listAllTickets(): Promise<any[]> {
    try {
      const tickets = this.readTable<any>("Tickets", DbTicketSchema);
      return tickets;
    } catch {
      return [];
    }
  }
}
