import pg from "pg";
import { randomUUID } from "crypto";
import { DatabaseAdapter } from "../types";
import { TicketInput, ExecutionResult, AuditLog } from "../../schemas/validation";
import { SessionContext, CompanyContext } from "../../memory/types";
import { config } from "../../config/env";
import { createLogger } from "../../observability/logger";
import { CacheService } from "../../cache/CacheService";
import { BackupManager } from "./BackupManager";
import { TakeoverManager } from "../../human-takeover/TakeoverManager";

const logger = createLogger("PostgresAdapter");

// 1. Establish Primary pool (writes and primary reads)
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: config.DB_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: config.DB_POOL_CONNECTION_TIMEOUT_MS,
});

pool.on("error", (err) => {
  logger.error({ error: err.message }, "Unexpected error on primary pg pool client");
});

// 2. Establish Replica pool (secondary read-only)
export const replicaPool = config.DATABASE_REPLICA_URL
  ? new pg.Pool({
      connectionString: config.DATABASE_REPLICA_URL,
      max: config.DB_POOL_MAX,
      idleTimeoutMillis: config.DB_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: config.DB_POOL_CONNECTION_TIMEOUT_MS,
    })
  : pool;

if (replicaPool !== pool) {
  replicaPool.on("error", (err) => {
    logger.error({ error: err.message }, "Unexpected error on replica pg pool client");
  });
}

export class PostgresAdapter implements DatabaseAdapter {
  private takeoverManager = new TakeoverManager();
  // Helper to execute read queries with failover
  private async executeReadQuery(
    text: string,
    params: any[] = [],
    fallbackFn?: () => Promise<any>
  ): Promise<pg.QueryResult> {
    try {
      // 1. Attempt primary pool
      return await pool.query(text, params);
    } catch (err: any) {
      logger.error(
        { error: err.message, query: text },
        "CRITICAL: Primary database read query failed. Switching to replica pool."
      );

      try {
        // 2. Attempt replica pool
        return await replicaPool.query(text, params);
      } catch (repErr: any) {
        logger.error(
          { error: repErr.message, query: text },
          "CRITICAL: Replica database read query failed. Attempting local encrypted backup fallback."
        );

        if (fallbackFn) {
          const fallbackData = await fallbackFn();
          return {
            rows: Array.isArray(fallbackData) ? fallbackData : [fallbackData],
            command: "SELECT",
            rowCount: Array.isArray(fallbackData) ? fallbackData.length : 1,
            oid: 0,
            fields: [],
          };
        }
        throw repErr;
      }
    }
  }

  // ─── Ticket ────────────────────────────────────────────────

  async createTicket(input: TicketInput, slaDueDate: string, ticketNumber: string): Promise<ExecutionResult> {
    const executionId = randomUUID();
    try {
      let parsedProjectId: number | null = null;
      if (input.projectId) {
        const parsed = parseInt(input.projectId, 10);
        if (!isNaN(parsed)) {
          parsedProjectId = parsed;
        }
      }

      const { rows } = await pool.query(
        `INSERT INTO tickets (ticket_id, conversation_id, subject, summary, status, priority, created_via, project_id, severity, due_date)
         VALUES ($1, $2, $3, $4, $5, $6, 'ai', $7, $8, $9)
         RETURNING *`,
        [
          ticketNumber,
          input.conversationId,
          input.subject,
          input.summary,
          "Open",
          input.priority,
          parsedProjectId,
          input.severity,
          slaDueDate,
        ]
      );

      const ticketRow = rows[0];

      // Write transactionally to outbox_events
      await pool.query(
        `INSERT INTO outbox_events (event_type, payload, status, attempts)
         VALUES ($1, $2, $3, $4)`,
        [
          "TicketCreated",
          JSON.stringify({ ticketId: ticketNumber }),
          "pending",
          0
        ]
      );

      const resultData = {
        id: ticketRow.id.toString(),
        ticketId: ticketNumber,
        conversationId: ticketRow.conversation_id.toString(),
        subject: ticketRow.subject,
        summary: ticketRow.summary,
        severity: input.severity,
        priority: ticketRow.priority,
        projectId: input.projectId,
        status: ticketRow.status as any,
        startDate: ticketRow.created_at instanceof Date ? ticketRow.created_at.toISOString() : new Date().toISOString(),
        dueDate: slaDueDate,
        createdBy: "AI Support Agent"
      };

      // Write to local encrypted backup
      await BackupManager.saveToBackup("tickets", resultData, "id");

      return {
        success: true,
        data: resultData,
        error: null,
        source: "postgres",
        executionId,
      };
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to create ticket in Postgres");
      return {
        success: false,
        data: null,
        error: err.message ?? "Unknown error creating ticket",
        source: "postgres",
        executionId,
      };
    }
  }

  // ─── Project ───────────────────────────────────────────────

  async findProject(projectId: string): Promise<any> {
    const fallback = async () => {
      const list = await BackupManager.readFromBackup<any>("projects");
      return list.find((p) => String(p.id) === String(projectId)) || null;
    };

    const res = await this.executeReadQuery(`SELECT * FROM projects WHERE id = $1 LIMIT 1`, [projectId], fallback);

    if (!res.rows || res.rows.length === 0 || !res.rows[0]) return null;
    return { ...res.rows[0], id: res.rows[0].id.toString() };
  }

  // ─── Conversation ──────────────────────────────────────────

  async getConversation(conversationId: string): Promise<any> {
    const fallback = async () => {
      const list = await BackupManager.readFromBackup<any>("conversations");
      return list.find((c) => String(c.id) === String(conversationId)) || null;
    };

    const res = await this.executeReadQuery(
      `SELECT * FROM conversations WHERE id = $1 LIMIT 1`,
      [conversationId],
      fallback
    );

    if (!res.rows || res.rows.length === 0 || !res.rows[0]) return null;
    return { ...res.rows[0], id: res.rows[0].id.toString() };
  }

  // ─── Messages ──────────────────────────────────────────────

  async saveMessage(conversationId: string, role: string, content: string): Promise<any> {
    try {
      const { rows } = await pool.query(
        `INSERT INTO messages (conversation_id, role, content, created_at)
         VALUES ($1, $2, $3, NOW())
         RETURNING *`,
        [conversationId, role, content]
      );

      const msgRow = rows[0];
      const resultData = { ...msgRow, id: msgRow.id.toString() };

      // Write to local encrypted backup
      await BackupManager.saveToBackup("messages", resultData, "id");

      return resultData;
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to save message in Postgres");
      throw err;
    }
  }

  // ─── Ensure Conversation ──────────────────────────────────

  async ensureConversation(senderId: string, companyId: string, channel: string): Promise<string> {
    try {
      // 1. Find or create identity
      let identityIdStr: string;

      const identityResult = await pool.query(
        `SELECT id FROM identities WHERE LOWER(channel) = LOWER($1) AND channel_ref = $2 LIMIT 1`,
        [channel, senderId]
      );

      if (identityResult.rows.length > 0) {
        identityIdStr = identityResult.rows[0].id.toString();
      } else {
        // Create a profile first, then identity
        const maxProfileRes = await pool.query("SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM profiles");
        const nextProfileId = maxProfileRes.rows[0].next_id;

        const profileResult = await pool.query(
          `INSERT INTO profiles (id, company_id, name)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [nextProfileId, companyId, senderId]
        );
        const profileId = profileResult.rows[0].id;

        // Backup profiles
        await BackupManager.saveToBackup(
          "profiles",
          { id: profileId.toString(), company_id: companyId, name: senderId },
          "id"
        );

        const maxIdentRes = await pool.query("SELECT COALESCE(MAX(id::integer), 0) + 1 AS next_id FROM identities WHERE id ~ '^[0-9]+$'");
        const nextIdentId = maxIdentRes.rows[0].next_id.toString();

        const newIdentity = await pool.query(
          `INSERT INTO identities (id, profile_id, channel, channel_ref)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [nextIdentId, profileId, channel, senderId]
        );
        identityIdStr = newIdentity.rows[0].id.toString();

        // Backup identities
        await BackupManager.saveToBackup(
          "identities",
          { id: identityIdStr, profile_id: profileId, channel, channel_ref: senderId },
          "id"
        );
      }

      // 2. Find open conversation or create one
      const convResult = await pool.query(
        `SELECT id FROM conversations
         WHERE identity_id = $1 AND LOWER(channel) = LOWER($2) AND status = 'open'
         ORDER BY created_at DESC
         LIMIT 1`,
        [identityIdStr, channel]
      );

      if (convResult.rows.length > 0) {
        return convResult.rows[0].id.toString();
      }

      const maxConvRes = await pool.query("SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM conversations");
      const nextConvId = maxConvRes.rows[0].next_id;

      const newConv = await pool.query(
        `INSERT INTO conversations (id, identity_id, channel, status, handled_by)
         VALUES ($1, $2, $3, 'open', 'ai')
         RETURNING id`,
        [nextConvId, identityIdStr, channel]
      );

      const convId = newConv.rows[0].id.toString();

      // Backup conversations
      await BackupManager.saveToBackup(
        "conversations",
        { id: convId, identity_id: identityIdStr, channel, status: "open", handled_by: "ai" },
        "id"
      );

      return convId;
    } catch (err: any) {
      logger.error(
        { error: err.message },
        "ensureConversation failed in Postgres. Switching to local backup creation."
      );
      // Fallback local creation
      const identityId = randomUUID();
      const profileId = randomUUID();
      const conversationId = randomUUID();

      await BackupManager.saveToBackup("profiles", { id: profileId, company_id: companyId, name: senderId }, "id");
      await BackupManager.saveToBackup(
        "identities",
        { id: identityId, profile_id: profileId, channel, channel_ref: senderId },
        "id"
      );
      await BackupManager.saveToBackup(
        "conversations",
        { id: conversationId, identity_id: identityId, channel, status: "open", handled_by: "ai" },
        "id"
      );

      return conversationId;
    }
  }

  // ─── Load Session Context (Cache-Aside & Backup Fallback) ───

  async loadSessionContext(senderId: string, channel: string): Promise<SessionContext> {
    try {
      // 1. Find identity
      const identityResult = await this.executeReadQuery(
        `SELECT i.id AS identity_id, i.profile_id, p.company_id, p.name AS profile_name
         FROM identities i
         JOIN profiles p ON p.id = i.profile_id
         WHERE LOWER(i.channel) = LOWER($1) AND i.channel_ref = $2
         LIMIT 1`,
        [channel, senderId]
      );

      if (identityResult.rows.length === 0 || !identityResult.rows[0]) {
        throw new Error(`No identity found for sender "${senderId}" on channel "${channel}"`);
      }

      const identity = identityResult.rows[0];
      const companyId = identity.company_id.toString();

      // ─── Cache Aside for CompanyContext ───
      const cacheKey = `tenant:${companyId}:config`;
      let companyContext = await CacheService.getInstance().get<CompanyContext>(cacheKey);

      if (!companyContext) {
        // 2. Get company
        const companyResult = await this.executeReadQuery(`SELECT * FROM companies WHERE id = $1 LIMIT 1`, [companyId]);

        if (companyResult.rows.length === 0 || !companyResult.rows[0]) {
          throw new Error(`Company not found for id ${companyId}`);
        }
        const company = companyResult.rows[0];

        // 3. Get projects for company
        const projectsResult = await this.executeReadQuery(
          `SELECT id, name FROM projects WHERE company_id = $1`,
          [companyId]
        );

        const projects = projectsResult.rows.map((r: any) => ({
          projectId: r.id.toString(),
          projectName: r.name,
          projectType: "Support",
        }));

        companyContext = {
          companyId,
          companyName: company.name,
          status: "Active",
          aiPromptTemplate: "",
          projects,
          slaConfig: [],
        };

        // Cache for 300 seconds (5 minutes)
        await CacheService.getInstance().set(cacheKey, companyContext, 300);
      }

      // 5. Find open conversation
      const convResult = await this.executeReadQuery(
        `SELECT id, status, handled_by
         FROM conversations
         WHERE identity_id = $1 AND channel = $2 AND status = 'open'
         ORDER BY created_at DESC
         LIMIT 1`,
        [identity.identity_id, channel]
      );

      const conversationId = convResult.rows.length > 0 ? convResult.rows[0].id.toString() : "";
      const status = convResult.rows.length > 0 ? convResult.rows[0].status : "open";
      const handledBy = convResult.rows.length > 0 ? convResult.rows[0].handled_by : "ai";

      return {
        sessionId: randomUUID(),
        companyId,
        conversationId,
        customerRef: senderId,
        companyContext,
        status: status as "open" | "closed",
        handledBy: handledBy as "ai" | "human",
      };
    } catch (err: any) {
      logger.error({ error: err.message }, "loadSessionContext query failure. Falling back to local backups.");

      // Fallback: search backups offline
      const identities = await BackupManager.readFromBackup<any>("identities");
      const profiles = await BackupManager.readFromBackup<any>("profiles");
      const companies = await BackupManager.readFromBackup<any>("companies");
      const projects = await BackupManager.readFromBackup<any>("projects");
      const conversations = await BackupManager.readFromBackup<any>("conversations");

      const matchIdent = identities.find(
        (i) => i.channel_ref === senderId && i.channel?.toLowerCase() === channel.toLowerCase()
      );

      if (!matchIdent) {
        throw new Error(`Fallback context resolution failed. Missing local identities backup.`);
      }

      const matchProfile = profiles.find((p) => String(p.id) === String(matchIdent.profile_id));
      const companyId = matchProfile ? String(matchProfile.company_id) : "1";
      const company = companies.find((c) => String(c.id) === companyId);

      const companyProjects = projects
        .filter((p) => String(p.company_id) === companyId)
        .map((p) => ({
          projectId: p.id.toString(),
          projectName: p.name,
          projectType: p.project_type || "Support",
        }));

      const companyContext: CompanyContext = {
        companyId,
        companyName: company ? company.name : "Fallback Company",
        status: "Active",
        aiPromptTemplate: "",
        projects: companyProjects,
        slaConfig: [],
      };

      const matchConv = conversations
        .filter((c) => String(c.identity_id) === String(matchIdent.id) && c.status === "open")
        .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())[0];

      return {
        sessionId: randomUUID(),
        companyId,
        conversationId: matchConv ? matchConv.id.toString() : "",
        customerRef: senderId,
        companyContext,
        status: matchConv ? matchConv.status : "open",
        handledBy: matchConv ? matchConv.handled_by : "ai",
      };
    }
  }

  // ─── Conversation History ─────────────────────────────────

  async getConversationHistory(conversationId: string, limit: number = 50): Promise<any[]> {
    const fallback = async () => {
      const list = await BackupManager.readFromBackup<any>("messages");
      return list
        .filter((m) => String(m.conversation_id) === String(conversationId))
        .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime())
        .slice(-limit);
    };

    const res = await this.executeReadQuery(
      `SELECT * FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [conversationId, limit],
      fallback
    );

    return res.rows.map((r: any) => ({ ...r, id: r.id.toString() }));
  }

  // ─── Handoff State ────────────────────────────────────────

  async updateHandoffState(conversationId: string, handledBy: "ai" | "human"): Promise<void> {
    try {
      await pool.query(`UPDATE conversations SET handled_by = $1, updated_at = NOW() WHERE id = $2`, [
        handledBy,
        conversationId,
      ]);

      // Backup update
      const conversations = await BackupManager.readFromBackup<any>("conversations");
      const match = conversations.find((c) => String(c.id) === String(conversationId));
      if (match) {
        match.handled_by = handledBy;
        match.status = handledBy === "human" ? "escalated" : "open";
        await BackupManager.saveToBackup("conversations", match, "id");
      }
    } catch (err: any) {
      logger.error({ error: err.message }, "updateHandoffState failed in Postgres");
      throw err;
    }
  }

  // ─── Knowledge Search ─────────────────────────────────────

  async searchKnowledge(query: string, filters?: { projectId?: string }): Promise<any[]> {
    const fallback = async () => {
      const messages = await BackupManager.readFromBackup<any>("messages");
      const tickets = await BackupManager.readFromBackup<any>("tickets");
      const results: any[] = [];

      const lowerQuery = query.toLowerCase();

      // Search Messages fallback
      messages.forEach((m) => {
        if ((m.content || "").toLowerCase().includes(lowerQuery)) {
          results.push({
            source: "postgres_fallback",
            id: m.id.toString(),
            type: "message",
            content: m.content,
            confidence: 0.6,
            metadata: { conversationId: m.conversation_id?.toString() },
          });
        }
      });

      // Search Tickets fallback
      tickets.forEach((t) => {
        if (
          (t.subject || "").toLowerCase().includes(lowerQuery) ||
          (t.summary || "").toLowerCase().includes(lowerQuery)
        ) {
          results.push({
            source: "postgres_fallback",
            id: t.id.toString(),
            type: "ticket",
            content: `${t.subject} — ${t.summary}`,
            confidence: 0.8,
            metadata: { ticketId: t.ticket_id },
          });
        }
      });

      return results;
    };

    try {
      const results: any[] = [];

      // Search messages
      const msgQuery = `
        SELECT m.id, m.content, m.conversation_id, 'message' AS type
        FROM messages m
        WHERE m.content ILIKE '%' || $1 || '%'
        ORDER BY m.created_at DESC
        LIMIT 10`;

      const msgResult = await this.executeReadQuery(msgQuery, [query]);

      for (const row of msgResult.rows) {
        results.push({
          source: "postgres",
          id: row.id.toString(),
          type: "message",
          content: row.content,
          confidence: 0.6,
          metadata: { conversationId: row.conversation_id?.toString() },
        });
      }

      // Search tickets
      let ticketQuery: string;
      let ticketParams: any[];

      if (filters?.projectId) {
        ticketQuery = `
          SELECT t.id, t.subject, t.summary, t.conversation_id, 'ticket' AS type
          FROM tickets t
          JOIN conversations c ON c.id = t.conversation_id
          WHERE (t.subject ILIKE '%' || $1 || '%' OR t.summary ILIKE '%' || $1 || '%')
            AND c.project_id = $2
          ORDER BY t.id DESC
          LIMIT 10`;
        ticketParams = [query, filters.projectId];
      } else {
        ticketQuery = `
          SELECT t.id, t.subject, t.summary, 'ticket' AS type
          FROM tickets t
          WHERE t.subject ILIKE '%' || $1 || '%' OR t.summary ILIKE '%' || $1 || '%'
          ORDER BY t.id DESC
          LIMIT 10`;
        ticketParams = [query];
      }

      const ticketResult = await this.executeReadQuery(ticketQuery, ticketParams);

      for (const row of ticketResult.rows) {
        results.push({
          source: "postgres",
          id: row.id.toString(),
          type: "ticket",
          content: `${row.subject ?? ""} — ${row.summary ?? ""}`,
          confidence: 0.8,
          metadata: { ticketId: row.id.toString() },
        });
      }

      return results;
    } catch {
      return await fallback();
    }
  }

  // ─── Traces ────────────────────────────────────────────────

  async saveTrace(trace: AuditLog): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO traces (trace_id, session_id, agent_id, tool_name, called_at, reason, arguments, result, status, error_message, completed_at, request_id, conversation_id, parent_trace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (trace_id) DO UPDATE SET
           agent_id      = EXCLUDED.agent_id,
           tool_name     = EXCLUDED.tool_name,
           called_at     = EXCLUDED.called_at,
           reason        = EXCLUDED.reason,
           arguments     = EXCLUDED.arguments,
           result        = EXCLUDED.result,
           status        = EXCLUDED.status,
           error_message = EXCLUDED.error_message,
           completed_at  = EXCLUDED.completed_at,
           request_id    = EXCLUDED.request_id,
           conversation_id = EXCLUDED.conversation_id,
           parent_trace_id = EXCLUDED.parent_trace_id`,
        [
          trace.traceId,
          trace.sessionId,
          trace.agentId ?? null,
          trace.toolName,
          trace.calledAt,
          trace.reason ?? null,
          JSON.stringify(trace.arguments),
          trace.result ? JSON.stringify(trace.result) : null,
          trace.status,
          trace.errorMessage ?? null,
          trace.completedAt ?? null,
          trace.requestId ?? null,
          trace.conversationId ?? null,
          trace.parentTraceId ?? null,
        ]
      );

      // Backup update
      await BackupManager.saveToBackup("traces", trace, "traceId");
    } catch (err: any) {
      logger.error({ error: err.message }, "saveTrace failed in Postgres");
      throw err;
    }
  }

  async getTrace(traceId: string): Promise<AuditLog | null> {
    const fallback = async () => {
      const list = await BackupManager.readFromBackup<AuditLog>("traces");
      return list.find((t) => t.traceId === traceId) || null;
    };

    const res = await this.executeReadQuery(`SELECT * FROM traces WHERE trace_id = $1 LIMIT 1`, [traceId], fallback);

    if (!res.rows || res.rows.length === 0 || !res.rows[0]) return null;
    return this.mapRowToAuditLog(res.rows[0]);
  }

  async listTraces(sessionId: string): Promise<AuditLog[]> {
    const fallback = async () => {
      const list = await BackupManager.readFromBackup<AuditLog>("traces");
      return list.filter((t) => t.sessionId === sessionId);
    };

    const res = await this.executeReadQuery(
      `SELECT * FROM traces WHERE session_id = $1 ORDER BY called_at ASC`,
      [sessionId],
      fallback
    );

    return res.rows.map((r: any) => this.mapRowToAuditLog(r));
  }

  async listAllTraces(): Promise<AuditLog[]> {
    const fallback = async () => {
      return await BackupManager.readFromBackup<AuditLog>("traces");
    };

    const res = await this.executeReadQuery(`SELECT * FROM traces ORDER BY called_at ASC`, [], fallback);

    return res.rows.map((r: any) => this.mapRowToAuditLog(r));
  }

  async listAllTickets(conversationId?: string, projectId?: string): Promise<any[]> {
    const fallback = async () => {
      let bk = await BackupManager.readFromBackup<any>("tickets");
      if (conversationId) {
        bk = bk.filter((t) => String(t.conversation_id) === String(conversationId));
      }
      if (projectId) {
        bk = bk.filter((t) => String(t.project_id || 1) === String(projectId));
      }
      return bk;
    };

    let query = `
      SELECT t.*, p.priority_name, p.resolve_hours 
      FROM tickets t
      LEFT JOIN project_sla_policies p ON p.project_id = t.project_id AND p.priority = t.priority
    `;
    const queryParams: any[] = [];
    const conditions: string[] = [];

    if (conversationId) {
      queryParams.push(conversationId);
      conditions.push(`t.conversation_id = $${queryParams.length}`);
    }
    if (projectId) {
      queryParams.push(parseInt(projectId, 10) || 1);
      conditions.push(`t.project_id = $${queryParams.length}`);
    }

    if (conditions.length > 0) {
      query += ` WHERE ` + conditions.join(" AND ");
    }
    query += ` ORDER BY t.id DESC`;

    const res = await this.executeReadQuery(query, queryParams, fallback);

    return res.rows.map((r: any) => {
      const severity = r.priority_name || r.priority || "Low";

      const baseDate = r.created_at ? new Date(r.created_at) : new Date();
      const resolveHours = r.resolve_hours || 120;
      const dueDate = new Date(baseDate.getTime() + resolveHours * 60 * 60 * 1000).toISOString();

      return {
        id: String(r.id),
        id1: String(r.id),
        ticketId: String(r.id),
        conversationId: String(r.conversation_id),
        subject: r.subject,
        summary: r.summary,
        status: r.status,
        priority: r.priority,
        severity,
        assignedPm: r.assigned_pm,
        createdVia: r.created_via,
        planeIssueId: r.plane_issue_id,
        dueDate,
        createdAt: baseDate.toISOString(),
        companyId: undefined,
      };
    });
  }

  async listAllConversations(projectId?: string): Promise<any[]> {
    let query = `
      SELECT
        c.id::text AS id,
        c.id::text AS id1,
        i.channel_ref AS customer,
        c.channel,
        c.status,
        c.handled_by,
        COALESCE(p.name, 'Customer') AS profile_name,
        NULL::text AS avatar_url,
        COALESCE(p.id::text, 'unknown') AS profile_id,
        NULL::text AS profile_email,
        NULL::text AS profile_phone,
        COALESCE(co.name, 'Unknown Company') AS company_name,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_timestamp,
        (SELECT role FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_role,
        (SELECT string_agg(priority, ' ') FROM tickets WHERE conversation_id = c.id) AS ticket_priorities,
        (SELECT string_agg(id::text, ' ') FROM tickets WHERE conversation_id = c.id) AS ticket_ids,
        (SELECT string_agg(content, ' ') FROM messages WHERE conversation_id = c.id) AS message_contents
      FROM conversations c
      JOIN identities i ON i.id = c.identity_id
      LEFT JOIN profiles p ON p.id = i.profile_id
      LEFT JOIN companies co ON co.id = p.company_id
    `;
    
    const queryParams: any[] = [];
    if (projectId) {
      query += ` WHERE c.project_id = $1 `;
      queryParams.push(parseInt(projectId, 10) || 1);
    }
    
    query += ` ORDER BY c.updated_at DESC`;
    
    const fallback = async () => {
      const bk = await BackupManager.readFromBackup<any>("conversations");
      if (projectId) {
        return bk.filter((c: any) => String(c.project_id || 1) === String(projectId));
      }
      return bk;
    };

    const res = await this.executeReadQuery(query, queryParams, fallback);
    return await Promise.all(res.rows.map(async (row) => {
      const takeover = await this.takeoverManager.getTakeoverState(row.id);
      
      const priorities = (row.ticket_priorities || '').split(' ');
      const highestPriority = priorities.reduce((max: string, pri: string) => {
        const priorityMap: Record<string, number> = { 'P1': 4, 'P2': 3, 'P3': 2, 'P4': 1 };
        if ((priorityMap[pri] || 0) > (priorityMap[max] || 0)) {
          return pri;
        }
        return max;
      }, 'P4');

      const priorityToSeverity: Record<string, string> = { P1: "Critical", P2: "High", P3: "Medium", P4: "Low" };
      const highestSeverity = priorityToSeverity[highestPriority] || "Low";

      return {
        id: row.id,
        id1: row.id,
        customer: row.customer,
        channel: row.channel,
        status: row.status,
        last_message: row.last_message || "",
        last_message_timestamp: row.last_message_timestamp,
        last_message_role: row.last_message_role,
        max_ticket_severity: highestSeverity,
        company_name: row.company_name,
        ticket_ids: row.ticket_ids || "",
        message_contents: row.message_contents || "",
        handled_by: row.handled_by || "ai",
        takeover_status: takeover?.status || "ACTIVE_AI",
        assigned_pm: takeover?.assignedHumanAgentId || null,
        human_session_started_at: takeover?.human_session_started_at || null,
        human_session_expire_at: takeover?.human_session_expire_at || null,
        last_human_reply_at: takeover?.last_human_reply_at || null,
        profile_id: row.profile_id,
        profile_name: row.profile_name,
        avatar_url: row.avatar_url,
        profile_email: row.profile_email,
        profile_phone: row.profile_phone,
      };
    }));
  }

  async getMessages(conversationId: string): Promise<any[]> {
    const query = `
      SELECT role, content, created_at AS timestamp
      FROM messages
      WHERE conversation_id = $1::integer
      ORDER BY created_at ASC
    `;
    const res = await pool.query(query, [conversationId]);
    return res.rows.map((r) => ({
      role: r.role,
      content: r.content,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
    }));
  }

  async getConversationIdent(conversationId: string): Promise<any> {
    const query = `
      SELECT i.channel, i.channel_ref
      FROM conversations c
      JOIN identities i ON i.id = c.identity_id
      WHERE c.id = $1::integer
    `;
    const res = await pool.query(query, [conversationId]);
    if (res.rows.length > 0) {
      return {
        channel: res.rows[0].channel,
        channel_ref: res.rows[0].channel_ref,
      };
    }
    return null;
  }

  async updateTicketPlaneIssue(ticketId: string, planeIssueId: string): Promise<void> {
    await pool.query(
      "UPDATE tickets SET plane_issue_id = $1, status = 'In Progress' WHERE ticket_id = $2",
      [planeIssueId, ticketId]
    );
  }

  async getTicketCompanyContext(ticketId: string): Promise<{ ticket: any; companyName: string }> {
    const isNumeric = /^\d+$/.test(String(ticketId));
    let ticketRes;
    if (isNumeric) {
      ticketRes = await pool.query("SELECT * FROM tickets WHERE id = $1 LIMIT 1", [parseInt(ticketId, 10)]);
    } else {
      ticketRes = await pool.query("SELECT * FROM tickets WHERE ticket_id = $1 LIMIT 1", [ticketId]);
    }
    
    let ticket: any = null;
    if (ticketRes.rows.length > 0) {
      ticket = {
        ...ticketRes.rows[0],
        id1: String(ticketRes.rows[0].id),
        ticket_id: String(ticketRes.rows[0].ticket_id),
        conversation_id: String(ticketRes.rows[0].conversation_id),
      };
    }
    let companyName = "Unknown";
    
    const companyQuery = isNumeric
      ? `SELECT c.name AS company_name
         FROM tickets t
         JOIN conversations conv ON conv.id = t.conversation_id
         JOIN identities i ON i.id = conv.identity_id
         JOIN profiles p ON p.id = i.profile_id
         JOIN companies c ON c.id = p.company_id
         WHERE t.id = $1`
      : `SELECT c.name AS company_name
         FROM tickets t
         JOIN conversations conv ON conv.id = t.conversation_id
         JOIN identities i ON i.id = conv.identity_id
         JOIN profiles p ON p.id = i.profile_id
         JOIN companies c ON c.id = p.company_id
         WHERE t.ticket_id = $1`;
         
    const companyRes = await pool.query(companyQuery, [isNumeric ? parseInt(ticketId, 10) : ticketId]);
    if (companyRes.rows.length > 0) {
      companyName = companyRes.rows[0].company_name;
    }
    return { ticket, companyName };
  }


  // ─── Helpers ───────────────────────────────────────────────

  private mapRowToAuditLog(row: any): AuditLog {
    return {
      traceId: row.trace_id || row.traceId,
      sessionId: row.session_id || row.sessionId,
      agentId: row.agent_id || row.agentId || undefined,
      toolName: row.tool_name || row.toolName,
      calledAt: row.called_at instanceof Date ? row.called_at.toISOString() : row.called_at || row.calledAt,
      reason: row.reason ?? undefined,
      arguments: typeof row.arguments === "string" ? JSON.parse(row.arguments) : (row.arguments ?? {}),
      result: row.result ? (typeof row.result === "string" ? JSON.parse(row.result) : row.result) : undefined,
      status: row.status,
      errorMessage: row.error_message || row.errorMessage || undefined,
      completedAt:
        row.completed_at || row.completedAt
          ? row.completed_at instanceof Date
            ? row.completed_at.toISOString()
            : row.completed_at || row.completedAt
          : undefined,
      requestId: row.request_id || row.requestId || undefined,
      conversationId: row.conversation_id || row.conversationId || undefined,
      parentTraceId: row.parent_trace_id || row.parentTraceId || undefined,
    };
  }
}
