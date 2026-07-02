import axios from "axios";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { DatabaseAdapter } from "../adapters/types";
import { TicketInput, ExecutionResult, AuditLog } from "../schemas/validation";
import { SessionContext, CompanyContext } from "../memory/types";
import { TakeoverManager } from "../human-takeover/TakeoverManager";

export class NocoDBAdapter implements DatabaseAdapter {
  private apiToken: string | undefined;
  private baseUrl: string;
  private baseId: string;
  private isProduction: boolean;

  private tableConversations = "mr7eft5bt196zwh";
  private tableMessages = "mwfbskyc6cdtmwi";
  private tableTickets = "mypt9rl2ua2nm0f";
  private tableIdentities = "mwd2n0jp72vxr8n";
  private tableProfiles = "m6mfl94nhczlzk0";
  private tableCompanies = "msjpa42nk5jqmen";

  private lastConvsFetch = 0;
  private cachedConvsList: any[] = [];
  private cachedConvs: any[] | null = null;
  private cachedIdents: any[] | null = null;
  private cachedMsgs: any[] | null = null;
  private lastTicketsFetch = 0;
  private cachedTicketsList: any[] = [];
  private cachedTickets: any[] | null = null;
  private takeoverManager = new TakeoverManager();
  
  private messagesCache = new Map<string, { data: any[]; timestamp: number }>();
  private pendingMessageRequests = new Map<string, Promise<any[]>>();
  private messagesWithIdsCache = new Map<string, { data: any[]; timestamp: number }>();
  private pendingMessageWithIdsRequests = new Map<string, Promise<any[]>>();
  private conversationsCache: { data: any[]; timestamp: number } | null = null;
  private pendingConversationRequest: Promise<any[]> | null = null;

  private circuitState: 'CLOSED' | 'OPEN' = 'CLOSED';
  private circuitOpenTime = 0;
  private failureCount = 0;

  constructor() {
    this.apiToken = process.env.NOCODB_TOKEN || process.env.NOCODB_API_TOKEN;
    this.baseUrl = process.env.NOCODB_URL || process.env.NOCODB_BASE_URL || "https://app.nocodb.com";
    this.baseId = process.env.NOCODB_BASE_ID || "pr3qdqjih5dlv8o";
    this.isProduction = process.env.NODE_ENV === "production";

    if (this.baseUrl.endsWith("/")) {
      this.baseUrl = this.baseUrl.slice(0, -1);
    }
  }

  private getTraceFilePath(): string {
    return path.resolve(process.cwd(), "data/Traces.json");
  }

  private readTraces(): AuditLog[] {
    try {
      const filePath = this.getTraceFilePath();
      if (!fs.existsSync(filePath)) return [];
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as AuditLog[];
    } catch {
      return [];
    }
  }

  private writeTraces(traces: AuditLog[]): void {
    try {
      const filePath = this.getTraceFilePath();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(traces, null, 2), "utf-8");
    } catch (e) {
      console.error("[NocoDBAdapter] Failed to write traces:", e);
    }
  }

  private async requestWithRetry<T>(
    fn: () => Promise<T>,
    delays = [1000, 2000, 4000],
    attempt = 0
  ): Promise<T> {
    const now = Date.now();
    if (this.circuitState === 'OPEN') {
      if (now - this.circuitOpenTime < 15000) {
        const err = new Error("NocoDB Circuit Breaker is OPEN");
        (err as any).isCircuitOpen = true;
        throw err;
      } else {
        this.circuitState = 'CLOSED';
        this.failureCount = 0;
        console.log("[NocoDBAdapter] Circuit Breaker reset to CLOSED");
      }
    }

    try {
      const res = await fn();
      this.failureCount = 0; // reset on success
      return res;
    } catch (e: any) {
      const is429 = e.response?.status === 429;
      const isTimeout = e.code === 'ECONNABORTED' || e.message?.toLowerCase().includes('timeout');
      
      if ((is429 || isTimeout) && attempt < delays.length) {
        const delay = delays[attempt];
        console.warn(`[NocoDBAdapter] Request failed (429/timeout). Retrying in ${delay}ms... Attempt ${attempt + 1}/${delays.length}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.requestWithRetry(fn, delays, attempt + 1);
      }

      // Exhausted retries (or not 429/timeout)
      if (is429 || isTimeout) {
        this.failureCount++;
        if (this.failureCount >= 3) {
          this.circuitState = 'OPEN';
          this.circuitOpenTime = Date.now();
          console.warn(`[NocoDBAdapter] Circuit Breaker opened due to ${this.failureCount} repeated NocoDB failures.`);
        }
      }
      throw e;
    }
  }

  private async getRows(tableId: string, params: any = {}, delays = [300, 800]): Promise<any[]> {
    if (!this.apiToken) {
      throw new Error("NocoDB API token is missing.");
    }
    const { timeout, ...restParams } = params;
    const response = await this.requestWithRetry(() => axios.get(`${this.baseUrl}/api/v1/db/data/v1/${this.baseId}/${tableId}`, {
      headers: {
        "xc-token": this.apiToken,
      },
      params: restParams,
      timeout: timeout || 15000,
    }), delays);
    return response.data?.list || response.data || [];
  }

  async createTicket(input: TicketInput, slaDueDate: string, ticketNumber: string): Promise<ExecutionResult> {
    const executionId = randomUUID();
    const ticketData = {
      ticket_id: ticketNumber,
      id1: ticketNumber,
      conversation_id: Number(input.conversationId) || input.conversationId,
      subject: input.subject,
      summary: input.summary,
      status: "Open",
      priority: input.priority || "normal",
      created_via: "ai",
    };

    try {
      if (!this.apiToken) {
        throw new Error("NocoDB API token is missing.");
      }

      const response = await this.requestWithRetry(() => axios.post(`${this.baseUrl}/api/v1/db/data/v1/${this.baseId}/${this.tableTickets}`, ticketData, {
        headers: {
          "xc-token": this.apiToken,
          "Content-Type": "application/json",
        },
        timeout: 5000,
      }));

      return {
        success: true,
        data: response.data,
        error: null,
        source: "nocodb_live",
        executionId,
      };
    } catch (e: any) {
      const errorMsg = e.response?.data?.message || e.message || String(e);
      console.error(`[NocoDBAdapter] createTicket failed: ${errorMsg}`);

      if (this.isProduction) {
        return {
          success: false,
          data: null,
          error: `NocoDB Connection Failure: ${errorMsg}`,
          source: "nocodb_live",
          executionId,
        };
      } else {
        console.warn(`[NocoDBAdapter] Development Fallback: NocoDB is offline (${errorMsg}). Mocking ticket creation.`);
        return {
          success: true,
          data: ticketData,
          error: null,
          source: "nocodb_mock",
          executionId,
        };
      }
    }
  }

  async findProject(projectId: string): Promise<any> {
    return { id1: projectId, name: "NocoDB Project", company_id: "1" };
  }

  async getConversation(conversationId: string): Promise<any> {
    try {
      if (!this.apiToken) throw new Error("NocoDB API token is missing.");
      const response = await this.requestWithRetry(() => axios.get(`${this.baseUrl}/api/v1/db/data/v1/${this.baseId}/${this.tableConversations}/${conversationId}`, {
        headers: {
          "xc-token": this.apiToken,
        },
        timeout: 5000,
      }), [300, 800]);
      const data = response.data;
      if (data) {
        return {
          ...data,
          id: String(data.id || data.id1),
          id1: String(data.id || data.id1),
        };
      }
      return null;
    } catch (e: any) {
      const errorMsg = e.response?.data?.message || e.message || String(e);
      console.error(`[NocoDBAdapter] getConversation failed: ${errorMsg}`);
      if (this.isProduction) throw e;
      return { id: conversationId, id1: conversationId, status: "open", handled_by: "ai" };
    }
  }

  async saveMessage(conversationId: string, role: string, content: string): Promise<any> {
    const messageData = {
      conversation_id: Number(conversationId) || conversationId,
      role,
      content,
      created_at: new Date().toISOString(),
    };

    try {
      if (!this.apiToken) {
        throw new Error("NocoDB API token is missing.");
      }
      const response = await this.requestWithRetry(() => axios.post(`${this.baseUrl}/api/v1/db/data/v1/${this.baseId}/${this.tableMessages}`, messageData, {
        headers: {
          "xc-token": this.apiToken,
          "Content-Type": "application/json",
        },
        timeout: 5000,
      }));
      return response.data;
    } catch (e: any) {
      const errorMsg = e.response?.data?.message || e.message || String(e);
      console.error(`[NocoDBAdapter] saveMessage failed: ${errorMsg}`);
      if (this.isProduction) {
        throw e;
      }
      return { id: "mock-msg-id", id1: "mock-msg-id", ...messageData };
    }
  }

  async ensureConversation(senderId: string, companyId: string, channel: string): Promise<string> {
    try {
      // 1. Resolve Identity
      const idents = await this.getRows(this.tableIdentities, {
        where: `(channel_ref,eq,${senderId})`,
        limit: 1,
      });

      let identityId: number;
      if (idents.length > 0) {
        identityId = idents[0].id;
      } else {
        // Create Identity
        const newIdent = await this.requestWithRetry(() => axios.post(
          `${this.baseUrl}/api/v1/db/data/v1/${this.baseId}/${this.tableIdentities}`,
          { channel, channel_ref: senderId },
          {
            headers: {
              "xc-token": this.apiToken!,
              "Content-Type": "application/json",
            },
            timeout: 5000,
          }
        ));
        identityId = newIdent.data.id;
      }

      // 2. Load Active Conversation
      const convs = await this.getRows(this.tableConversations, {
        where: `(identity_id,eq,${identityId})~and(status,eq,open)`,
        limit: 1,
      });

      if (convs.length > 0) {
        return String(convs[0].id);
      }

      // Create new conversation
      const newConv = await this.requestWithRetry(() => axios.post(
        `${this.baseUrl}/api/v1/db/data/v1/${this.baseId}/${this.tableConversations}`,
        {
          identity_id: identityId,
          channel,
          status: "open",
          handled_by: "ai",
        },
        {
          headers: {
            "xc-token": this.apiToken!,
            "Content-Type": "application/json",
          },
          timeout: 5000,
        }
      ));

      return String(newConv.data.id);
    } catch (e: any) {
      console.error("[NocoDBAdapter] ensureConversation failed:", e.message);
      return `conv_${senderId}`;
    }
  }

  async loadSessionContext(senderId: string, channel: string): Promise<SessionContext> {
    const companyContext: CompanyContext = {
      companyId: "1",
      companyName: "Orbit Retail Co., Ltd.",
      status: "Active" as const,
      aiPromptTemplate: `คุณคือ Support Agent AI สำหรับช่วยเหลือผู้ใช้ระบบ IT ของ Orbit Retail`,
      projects: [{ projectId: "1", projectName: "Orbit POS System", projectType: "Support" }],
      slaConfig: [{ projectId: "1", severity: "High", responseTimeHours: 4, resolveTimeHours: 12 }],
    };

    try {
      // 1. Get identity
      const idents = await this.getRows(this.tableIdentities, {
        where: `(channel_ref,eq,${senderId})`,
        limit: 1,
      });
      if (idents.length === 0) {
        throw new Error(`Identity not found for ${senderId} on ${channel}`);
      }
      const identityId = idents[0].Id || idents[0].id || idents[0].id1;

      // 2. Get active open conversation
      const convs = await this.getRows(this.tableConversations, {
        where: `(identity_id,eq,${identityId})~and(status,eq,open)`,
        limit: 1,
      });

      let conversationId: string;
      let handledBy = "ai";
      if (convs.length > 0) {
        conversationId = String(convs[0].Id || convs[0].id || convs[0].id1);
        handledBy = convs[0].handled_by || "ai";
      } else {
        // Create new
        conversationId = await this.ensureConversation(senderId, "1", channel);
      }

      return {
        sessionId: `sess_conv_${senderId}`,
        companyId: "1",
        conversationId,
        customerRef: senderId,
        companyContext,
        status: "open",
        handledBy: handledBy as any,
      };
    } catch (e: any) {
      console.error("[NocoDBAdapter] loadSessionContext failed:", e.message);
      return {
        sessionId: `sess_conv_${senderId}`,
        companyId: "1",
        conversationId: `conv_${senderId}`,
        customerRef: senderId,
        companyContext,
        status: "open",
        handledBy: "ai",
      };
    }
  }

  async getConversationHistory(conversationId: string, limit?: number): Promise<any[]> {
    return this.getMessages(conversationId);
  }

  async updateHandoffState(conversationId: string, handledBy: "ai" | "human"): Promise<void> {
    try {
      this.lastConvsFetch = 0; // Invalidate conversations cache
      if (!this.apiToken) throw new Error("NocoDB token missing");
      await this.requestWithRetry(() => axios.patch(
        `${this.baseUrl}/api/v1/db/data/v1/${this.baseId}/${this.tableConversations}/${conversationId}`,
        {
          handled_by: handledBy,
        },
        {
          headers: {
            "xc-token": this.apiToken,
            "Content-Type": "application/json",
          },
          timeout: 5000,
        }
      ));
      console.log(JSON.stringify({
        "[NocoDBAdapter]": {
          operation: "updateHandoffState",
          status: "success",
          fallback_cache_used: false,
          error: null
        }
      }));
    } catch (e: any) {
      console.error(JSON.stringify({
        "[NocoDBAdapter]": {
          operation: "updateHandoffState",
          status: "error",
          fallback_cache_used: false,
          error: e.message || String(e)
        }
      }));
    }
  }

  async searchKnowledge(query: string, filters?: { projectId?: string }): Promise<any[]> {
    return [];
  }

  async saveTrace(trace: AuditLog): Promise<void> {
    const traces = this.readTraces();
    const idx = traces.findIndex((t) => t.traceId === trace.traceId);
    if (idx !== -1) {
      traces[idx] = trace;
    } else {
      traces.push(trace);
    }
    this.writeTraces(traces);
  }

  async getTrace(traceId: string): Promise<AuditLog | null> {
    const traces = this.readTraces();
    return traces.find((t) => t.traceId === traceId) || null;
  }

  async listTraces(sessionId: string): Promise<AuditLog[]> {
    const traces = this.readTraces();
    return traces.filter((t) => t.sessionId === sessionId);
  }

  async listAllTraces(): Promise<AuditLog[]> {
    return this.readTraces();
  }

  private extractId(field: any): any {
    if (typeof field === "object" && field !== null) {
      return field.Id || field.id || field.id1;
    }
    return field;
  }

  async listAllTickets(conversationId?: string): Promise<any[]> {
    const now = Date.now();
    // Cache for 8 seconds to prevent excessive NocoDB calls when no conversation filter is applied
    if (!conversationId && this.cachedTicketsList.length > 0 && (now - this.lastTicketsFetch) < 8000) {
      return this.cachedTicketsList;
    }

    try {
      const params: any = { limit: 1000, sort: "-Id" };
      if (conversationId) {
        params.where = `(conversation_id,eq,${conversationId})`;
      }

      const rows = await this.getRows(this.tableTickets, params).then(r => { this.cachedTickets = r; return r; }).catch(err => {
        if (this.cachedTickets) {
          return this.cachedTickets;
        }
        throw err;
      });

      const mapped = rows.map((r: any) => {
        const tid = String(r.Id || r.id || r.id1);
        const convId = this.extractId(r.conversation_id);
        return {
          id: tid,
          id1: r.id1 || tid,
          ticketId: r.ticket_id || r.id1 || r.ticketId || tid,
          conversationId: convId ? String(convId) : "",
          subject: r.subject || "",
          summary: r.summary || "",
          status: r.status || "Open",
          priority: r.priority || "normal",
          severity: r.severity || "normal",
          assignedPm: r.assigned_pm || null,
          createdVia: r.created_via || "ai",
          planeIssueId: r.plane_issue_id || null,
          dueDate: r.due_date || r.dueDate || null,
          createdAt: r.CreatedAt || r.created_at || r.createdAt || null,
        };
      });

      if (!conversationId) {
        this.cachedTicketsList = mapped;
        this.lastTicketsFetch = now;
      }

      console.log(JSON.stringify({
        "[NocoDBAdapter]": {
          operation: "listAllTickets",
          status: "success",
          fallback_cache_used: false,
          error: null
        }
      }));

      return mapped;
    } catch (e: any) {
      console.error(JSON.stringify({
        "[NocoDBAdapter]": {
          operation: "listAllTickets",
          status: "error",
          fallback_cache_used: !conversationId && this.cachedTicketsList.length > 0,
          error: e.message || String(e)
        }
      }));

      if (!conversationId && this.cachedTicketsList.length > 0) {
        return this.cachedTicketsList;
      }
      return [];
    }
  }

  async listAllConversations(): Promise<any[]> {
    const now = Date.now();

    // 3. Circuit open check without cache
    const isCircuitCurrentlyOpen = this.circuitState === 'OPEN' && (now - this.circuitOpenTime < 15000);
    if (isCircuitCurrentlyOpen && !this.conversationsCache && this.cachedConvsList.length === 0) {
      console.warn(JSON.stringify({
        "[NocoDBAdapter]": {
          operation: "listAllConversations",
          status: "circuit_open_no_cache",
          fallback_cache_used: false
        }
      }));
      return [];
    }

    if (this.conversationsCache) {
      const isFresh = (now - this.conversationsCache.timestamp) < 30000;
      if (isFresh) {
        console.log(JSON.stringify({
          "[NocoDBAdapter]": {
            operation: "listAllConversations",
            status: "success",
            fallback_cache_used: false,
            cache_hit: true,
            error: null
          }
        }));
        return this.conversationsCache.data;
      } else {
        // Stale cache: return immediately + background refresh
        console.log(JSON.stringify({
          "[NocoDBAdapter]": {
            operation: "listAllConversations",
            status: "success",
            fallback_cache_used: false,
            stale_hit: true,
            error: null
          }
        }));
        this.revalidateAllConversations().catch(() => {});
        return this.conversationsCache.data;
      }
    }

    // Fallback to cachedConvsList if it exists and conversationsCache does not
    if (this.cachedConvsList.length > 0) {
      console.log(JSON.stringify({
        "[NocoDBAdapter]": {
          operation: "listAllConversations",
          status: "success",
          fallback_cache_used: false,
          stale_hit: true,
          error: null
        }
      }));
      this.revalidateAllConversations().catch(() => {});
      return this.cachedConvsList;
    }

    // No cache exists at all: blocking synchronous fetch
    return this.revalidateAllConversations();
  }

  private async revalidateAllConversations(): Promise<any[]> {
    if (!this.pendingConversationRequest) {
      this.pendingConversationRequest = (async () => {
        const now = Date.now();
        try {
          const [convs, idents, msgs, tickets, profiles, companies] = await Promise.all([
            this.getRows(this.tableConversations, { limit: 1000, sort: "-Id" }, [100, 300]).then(r => { this.cachedConvs = r; return r; }).catch(err => {
              if (this.cachedConvs) return this.cachedConvs;
              throw err;
            }),
            this.getRows(this.tableIdentities, { limit: 1000, sort: "-Id" }, [100, 300]).then(r => { this.cachedIdents = r; return r; }).catch(err => {
              if (this.cachedIdents) return this.cachedIdents;
              throw err;
            }),
            this.getRows(this.tableMessages, { limit: 1000, sort: "-Id" }, [100, 300]).then(r => { this.cachedMsgs = r; return r; }).catch(err => {
              if (this.cachedMsgs) return this.cachedMsgs;
              throw err;
            }),
            this.getRows(this.tableTickets, { limit: 1000, sort: "-Id" }, [100, 300]).then(r => { this.cachedTickets = r; return r; }).catch(err => {
              if (this.cachedTickets) return this.cachedTickets;
              return [];
            }),
            this.getRows(this.tableProfiles, { limit: 1000 }, [100, 300]).catch(() => []),
            this.getRows(this.tableCompanies, { limit: 1000 }, [100, 300]).catch(() => []),
          ]);

          const result = convs.map((c: any) => {
            const cid = String(c.Id || c.id || c.id1);
            const identityId = this.extractId(c.identity_id);
            
            // Find identity
            const ident = idents.find((i: any) => {
              const iid = String(i.Id || i.id || i.id1);
              return String(identityId) === iid;
            });

            // Get all messages for this room
            const convMsgs = msgs.filter((m: any) => String(this.extractId(m.conversation_id)) === cid);
            // Find last message (since msgs is sorted by -Id, convMsgs[0] is the newest)
            const lastMsg = convMsgs[0];

            // Find all tickets for this room
            const convTickets = tickets.filter((t: any) => String(this.extractId(t.conversation_id)) === cid);

            // Resolve company name
            // Resolve profile details
            let profileName = "Nattapong";
            let avatarUrl: string | null = null;
            let profileId = "unknown";
            let profileEmail: string | null = null;
            let profilePhone: string | null = null;
            let companyName = "Orbit Retail";

            if (ident) {
              const profId = this.extractId(ident.profile_id);
              const profile = profiles.find((p: any) => String(p.Id || p.id || p.id1) === String(profId));
              if (profile) {
                profileName = profile.display_name || profile.name || "Nattapong";
                avatarUrl = profile.avatar_url || null;
                profileId = String(profile.Id || profile.id || profile.id1);
                profileEmail = profile.email || null;
                profilePhone = profile.phone || null;

                const companyId = this.extractId(profile.company_id || profile.company);
                const company = companies.find((co: any) => String(co.Id || co.id || co.id1) === String(companyId));
                if (company) {
                  companyName = company.name || "Orbit Retail";
                }
              }
            }

            // Calculate highest severity among tickets
            const highestSeverity = convTickets.reduce((max: string, t: any) => {
              const sev = t.severity || 'Low';
              const priorityMap: Record<string, number> = { 'Critical': 4, 'High': 3, 'Medium': 2, 'Low': 1 };
              if ((priorityMap[sev] || 0) > (priorityMap[max] || 0)) {
                return sev;
              }
              return max;
            }, 'Low');

            // Joined fields for local search
            const ticketIds = convTickets.map((t: any) => String(t.ticket_id || t.ticketId || t.Id || t.id || '')).join(' ');
            const messageContents = convMsgs.map((m: any) => String(m.content || '')).join(' ');

            const takeover = this.takeoverManager.getTakeoverState(cid);

            return {
              id: cid,
              id1: cid,
              customer: ident ? String(ident.channel_ref) : "unknown",
              channel: String(c.channel || (ident ? ident.channel : "line")),
              status: String(c.status || "open"),
              last_message: lastMsg ? String(lastMsg.content || "") : "",
              last_message_timestamp: lastMsg ? (lastMsg.created_at || lastMsg.CreatedAt) : null,
              last_message_role: lastMsg ? lastMsg.role : null,
              max_ticket_severity: highestSeverity,
              company_name: companyName,
              ticket_ids: ticketIds,
              message_contents: messageContents,
              handled_by: String(c.handled_by || "ai"),
              human_session_started_at: takeover?.human_session_started_at || null,
              human_session_expire_at: takeover?.human_session_expire_at || null,
              last_human_reply_at: takeover?.last_human_reply_at || null,
              profile_id: profileId,
              profile_name: profileName,
              avatar_url: avatarUrl,
              profile_email: profileEmail,
              profile_phone: profilePhone,
            };
          });

          this.conversationsCache = {
            data: result,
            timestamp: Date.now()
          };
          this.cachedConvsList = result;
          this.lastConvsFetch = now;

          console.log(JSON.stringify({
            "[NocoDBAdapter]": {
              operation: "listAllConversations",
              status: "success",
              fallback_cache_used: false,
              error: null
            }
          }));

          return result;
        } catch (e: any) {
          if (this.conversationsCache) {
            console.warn(JSON.stringify({
              "[NocoDBAdapter]": {
                operation: "listAllConversations",
                status: "fallback_cache",
                fallback_cache_used: true
              }
            }));
            return this.conversationsCache.data;
          }

          if (this.cachedConvsList.length > 0) {
            console.warn(JSON.stringify({
              "[NocoDBAdapter]": {
                operation: "listAllConversations",
                status: "fallback_cache",
                fallback_cache_used: true
              }
            }));
            return this.cachedConvsList;
          }

          throw e;
        } finally {
          this.pendingConversationRequest = null;
        }
      })();
    }

    try {
      return await this.pendingConversationRequest;
    } catch (e: any) {
      if (this.conversationsCache) return this.conversationsCache.data;
      if (this.cachedConvsList.length > 0) return this.cachedConvsList;
      return [];
    }
  }

  async getMessages(conversationId: string): Promise<any[]> {
    const cached = this.messagesCache.get(conversationId);
    if (cached) {
      console.log(JSON.stringify({
        "[NocoDBAdapter]": {
          operation: "getMessages",
          status: "success",
          fallback_cache_used: false,
          stale_hit: true,
          error: null
        }
      }));
      // Revalidate in background
      this.revalidateMessages(conversationId).catch(() => {});
      return cached.data;
    }
    return this.revalidateMessages(conversationId);
  }

  private async revalidateMessages(conversationId: string): Promise<any[]> {
    let pending = this.pendingMessageRequests.get(conversationId);
    if (!pending) {
      pending = (async () => {
        try {
          const msgs = await this.getRows(this.tableMessages, {
            where: `(conversation_id,eq,${conversationId})`,
            limit: 1000,
            sort: "Id",
            timeout: 15000,
          });

          const mapped = msgs.map((m: any) => ({
            role: m.role || "customer",
            content: m.content || "",
            timestamp: m.created_at || m.CreatedAt || new Date().toISOString(),
          }));

          this.messagesCache.set(conversationId, {
            data: mapped,
            timestamp: Date.now()
          });

          return mapped;
        } catch (e: any) {
          const isCircuitOpen = e.isCircuitOpen || this.circuitState === 'OPEN';
          if (isCircuitOpen) {
            console.warn(JSON.stringify({
              "[NocoDBAdapter]": {
                nocodb_circuit: "open",
                fallback_cache_used: true
              }
            }));
          } else {
            console.error(JSON.stringify({
              "[NocoDBAdapter]": {
                operation: "getMessages",
                status: "error",
                fallback_cache_used: true,
                error: e.message || String(e)
              }
            }));
          }

          const lastCache = this.messagesCache.get(conversationId);
          if (lastCache) return lastCache.data;
          throw e;
        } finally {
          this.pendingMessageRequests.delete(conversationId);
        }
      })();
      this.pendingMessageRequests.set(conversationId, pending);
    }

    try {
      return await pending;
    } catch (e: any) {
      const lastCache = this.messagesCache.get(conversationId);
      if (lastCache) return lastCache.data;

      if (this.cachedMsgs) {
        const fallbackMsgs = this.cachedMsgs
          .filter((m: any) => String(this.extractId(m.conversation_id)) === String(conversationId))
          .sort((a, b) => (a.Id || 0) - (b.Id || 0));

        const mapped = fallbackMsgs.map((m: any) => ({
          role: m.role || "customer",
          content: m.content || "",
          timestamp: m.created_at || m.CreatedAt || new Date().toISOString(),
        }));

        this.messagesCache.set(conversationId, { data: mapped, timestamp: Date.now() });
        return mapped;
      }
      return [];
    }
  }

  async getMessagesWithIds(conversationId: string): Promise<any[]> {
    const cached = this.messagesWithIdsCache.get(conversationId);
    if (cached) {
      console.log(JSON.stringify({
        "[NocoDBAdapter]": {
          operation: "getMessagesWithIds",
          status: "success",
          fallback_cache_used: false,
          stale_hit: true,
          error: null
        }
      }));
      // Revalidate in background
      this.revalidateMessagesWithIds(conversationId).catch(() => {});
      return cached.data;
    }
    return this.revalidateMessagesWithIds(conversationId);
  }

  private async revalidateMessagesWithIds(conversationId: string): Promise<any[]> {
    let pending = this.pendingMessageWithIdsRequests.get(conversationId);
    if (!pending) {
      pending = (async () => {
        try {
          const msgs = await this.getRows(this.tableMessages, {
            where: `(conversation_id,eq,${conversationId})`,
            limit: 1000,
            sort: "Id",
            timeout: 15000,
          });

          const mapped = msgs.map((m: any) => ({
            id: String(m.Id || m.id || ""),
            role: m.role || "customer",
            content: m.content || "",
            timestamp: m.created_at || m.CreatedAt || new Date().toISOString(),
          }));

          this.messagesWithIdsCache.set(conversationId, {
            data: mapped,
            timestamp: Date.now()
          });

          return mapped;
        } catch (e: any) {
          const isCircuitOpen = e.isCircuitOpen || this.circuitState === 'OPEN';
          if (isCircuitOpen) {
            console.warn(JSON.stringify({
              "[NocoDBAdapter]": {
                nocodb_circuit: "open",
                fallback_cache_used: true
              }
            }));
          } else {
            console.error(JSON.stringify({
              "[NocoDBAdapter]": {
                operation: "getMessagesWithIds",
                status: "error",
                fallback_cache_used: true,
                error: e.message || String(e)
              }
            }));
          }

          const lastCache = this.messagesWithIdsCache.get(conversationId);
          if (lastCache) return lastCache.data;
          throw e;
        } finally {
          this.pendingMessageWithIdsRequests.delete(conversationId);
        }
      })();
      this.pendingMessageWithIdsRequests.set(conversationId, pending);
    }

    try {
      return await pending;
    } catch (e: any) {
      const lastCache = this.messagesWithIdsCache.get(conversationId);
      if (lastCache) return lastCache.data;

      if (this.cachedMsgs) {
        const fallbackMsgs = this.cachedMsgs
          .filter((m: any) => String(this.extractId(m.conversation_id)) === String(conversationId))
          .sort((a, b) => (a.Id || 0) - (b.Id || 0));

        const mapped = fallbackMsgs.map((m: any) => ({
          id: String(m.Id || m.id || ""),
          role: m.role || "customer",
          content: m.content || "",
          timestamp: m.created_at || m.CreatedAt || new Date().toISOString(),
        }));

        this.messagesWithIdsCache.set(conversationId, { data: mapped, timestamp: Date.now() });
        return mapped;
      }
      return [];
    }
  }

  async getConversationIdent(conversationId: string): Promise<any> {
    try {
      if (!this.apiToken) throw new Error("NocoDB token missing");
      const convRes = await this.requestWithRetry(() => axios.get(`${this.baseUrl}/api/v1/db/data/v1/${this.baseId}/${this.tableConversations}/${conversationId}`, {
        headers: { "xc-token": this.apiToken },
      }), [300, 800]);
      const conv = convRes.data;

      const identityId = this.extractId(conv?.identity_id);

      if (identityId) {
        const identRes = await this.requestWithRetry(() => axios.get(`${this.baseUrl}/api/v1/db/data/v1/${this.baseId}/${this.tableIdentities}/${identityId}`, {
          headers: { "xc-token": this.apiToken },
        }), [300, 800]);
        return {
          channel: identRes.data.channel,
          channel_ref: identRes.data.channel_ref,
        };
      }
      return null;
    } catch (e: any) {
      console.error("[NocoDBAdapter] getConversationIdent failed:", e.message);
      return null;
    }
  }

  async updateTicketPlaneIssue(ticketId: string, planeIssueId: string): Promise<void> {
    try {
      if (!this.apiToken) throw new Error("NocoDB token missing");
      await this.requestWithRetry(() => axios.patch(
        `${this.baseUrl}/api/v1/db/data/v1/${this.baseId}/${this.tableTickets}/${ticketId}`,
        {
          plane_issue_id: planeIssueId,
          status: "In Progress",
        },
        {
          headers: {
            "xc-token": this.apiToken,
            "Content-Type": "application/json",
          },
          timeout: 5000,
        }
      ));
    } catch (e: any) {
      console.error("[NocoDBAdapter] updateTicketPlaneIssue failed:", e.message);
    }
  }

  async getTicketCompanyContext(ticketId: string): Promise<{ ticket: any; companyName: string }> {
    try {
      if (!this.apiToken) throw new Error("NocoDB token missing");
      const tickRes = await this.requestWithRetry(() => axios.get(`${this.baseUrl}/api/v1/db/data/v1/${this.baseId}/${this.tableTickets}/${ticketId}`, {
        headers: { "xc-token": this.apiToken },
      }), [300, 800]);
      const ticket = tickRes.data;
      let companyName = "Unknown";

      const convId = this.extractId(ticket?.conversation_id);

      if (convId) {
        const convRes = await this.requestWithRetry(() => axios.get(`${this.baseUrl}/api/v1/db/data/v1/${this.baseId}/${this.tableConversations}/${convId}`, {
          headers: { "xc-token": this.apiToken },
        }), [300, 800]);
        const conv = convRes.data;

        const identityId = this.extractId(conv?.identity_id);

        if (identityId) {
          const identRes = await this.requestWithRetry(() => axios.get(`${this.baseUrl}/api/v1/db/data/v1/${this.baseId}/${this.tableIdentities}/${identityId}`, {
            headers: { "xc-token": this.apiToken },
          }), [300, 800]);
          const ident = identRes.data;

          const profileId = this.extractId(ident?.profile_id);

          if (profileId) {
            const profRes = await this.requestWithRetry(() => axios.get(`${this.baseUrl}/api/v1/db/data/v1/${this.baseId}/${this.tableProfiles}/${profileId}`, {
              headers: { "xc-token": this.apiToken },
            }), [300, 800]);
            const profile = profRes.data;
            const compId = this.extractId(profile?.company_id || profile?.company);

            if (compId) {
              const compRes = await this.requestWithRetry(() => axios.get(`${this.baseUrl}/api/v1/db/data/v1/${this.baseId}/${this.tableCompanies}/${compId}`, {
                headers: { "xc-token": this.apiToken },
              }), [300, 800]);
              companyName = compRes.data.name || "Unknown";
            }
          }
        }
      }

      return {
        ticket: ticket
          ? {
              ...ticket,
              id1: ticket.id1 || String(ticket.Id || ticket.id),
              ticket_id: ticket.ticket_id || ticket.id1 || String(ticket.Id || ticket.id),
              conversation_id: convId ? String(convId) : "",
            }
          : null,
        companyName,
      };
    } catch (e: any) {
      console.error("[NocoDBAdapter] getTicketCompanyContext failed:", e.message);
      return { ticket: null, companyName: "Unknown" };
    }
  }
}
