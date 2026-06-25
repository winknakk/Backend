import pg from "pg";
import { randomUUID } from "crypto";
import { DatabaseAdapter } from "../types";
import { TicketInput, ExecutionResult, AuditLog } from "../../schemas/validation";
import { SessionContext, CompanyContext } from "../../memory/types";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export class PostgresAdapter implements DatabaseAdapter {
  // ─── Ticket ────────────────────────────────────────────────

  async createTicket(
    input: TicketInput,
    slaDueDate: string,
    ticketNumber: string,
  ): Promise<ExecutionResult> {
    const executionId = randomUUID();
    try {
      const { rows } = await pool.query(
        `INSERT INTO tickets (ticket_id, conversation_id, subject, summary, status, priority, severity, due_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          ticketNumber,
          input.conversationId,
          input.subject,
          input.summary,
          "Open",
          input.priority,
          input.severity,
          slaDueDate,
        ],
      );

      return {
        success: true,
        data: { ...rows[0], id: rows[0].id.toString() },
        error: null,
        source: "postgres",
        executionId,
      };
    } catch (err: any) {
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
    const { rows } = await pool.query(
      `SELECT * FROM projects WHERE id = $1 LIMIT 1`,
      [projectId],
    );
    if (rows.length === 0) return null;
    return { ...rows[0], id: rows[0].id.toString() };
  }

  // ─── Conversation ──────────────────────────────────────────

  async getConversation(conversationId: string): Promise<any> {
    const { rows } = await pool.query(
      `SELECT * FROM conversations WHERE id = $1 LIMIT 1`,
      [conversationId],
    );
    if (rows.length === 0) return null;
    return { ...rows[0], id: rows[0].id.toString() };
  }

  // ─── Messages ──────────────────────────────────────────────

  async saveMessage(
    conversationId: string,
    role: string,
    content: string,
  ): Promise<any> {
    const { rows } = await pool.query(
      `INSERT INTO messages (conversation_id, role, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [conversationId, role, content],
    );
    return { ...rows[0], id: rows[0].id.toString() };
  }

  // ─── Ensure Conversation ──────────────────────────────────

  async ensureConversation(
    senderId: string,
    companyId: string,
    channel: string,
  ): Promise<string> {
    // 1. Find or create identity
    let identityId: number;

    const identityResult = await pool.query(
      `SELECT id FROM identities WHERE channel = $1 AND channel_ref = $2 LIMIT 1`,
      [channel, senderId],
    );

    if (identityResult.rows.length > 0) {
      identityId = identityResult.rows[0].id;
    } else {
      // Create a profile first, then identity
      const profileResult = await pool.query(
        `INSERT INTO profiles (company_id, name)
         VALUES ($1, $2)
         RETURNING id`,
        [companyId, senderId],
      );
      const profileId = profileResult.rows[0].id;

      const newIdentity = await pool.query(
        `INSERT INTO identities (profile_id, channel, channel_ref)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [profileId, channel, senderId],
      );
      identityId = newIdentity.rows[0].id;
    }

    // 2. Find open conversation or create one
    const convResult = await pool.query(
      `SELECT id FROM conversations
       WHERE identity_id = $1 AND channel = $2 AND status = 'open'
       ORDER BY created_at DESC
       LIMIT 1`,
      [identityId, channel],
    );

    if (convResult.rows.length > 0) {
      return convResult.rows[0].id.toString();
    }

    const newConv = await pool.query(
      `INSERT INTO conversations (identity_id, channel, status, handled_by)
       VALUES ($1, $2, 'open', 'ai')
       RETURNING id`,
      [identityId, channel],
    );

    return newConv.rows[0].id.toString();
  }

  // ─── Load Session Context ─────────────────────────────────

  async loadSessionContext(
    senderId: string,
    channel: string,
  ): Promise<SessionContext> {
    // 1. Find identity
    const identityResult = await pool.query(
      `SELECT i.id AS identity_id, i.profile_id, p.company_id, p.name AS profile_name
       FROM identities i
       JOIN profiles p ON p.id = i.profile_id
       WHERE i.channel = $1 AND i.channel_ref = $2
       LIMIT 1`,
      [channel, senderId],
    );

    if (identityResult.rows.length === 0) {
      throw new Error(
        `No identity found for sender "${senderId}" on channel "${channel}"`,
      );
    }

    const identity = identityResult.rows[0];
    const companyId = identity.company_id;

    // 2. Get company
    const companyResult = await pool.query(
      `SELECT * FROM companies WHERE id = $1 LIMIT 1`,
      [companyId],
    );

    if (companyResult.rows.length === 0) {
      throw new Error(`Company not found for id ${companyId}`);
    }
    const company = companyResult.rows[0];

    // 3. Get projects for company
    const projectsResult = await pool.query(
      `SELECT id, name, project_type FROM projects WHERE company_id = $1`,
      [companyId],
    );

    const projects = projectsResult.rows.map((r: any) => ({
      projectId: r.id.toString(),
      projectName: r.name,
      projectType: r.project_type,
    }));

    // 4. Build CompanyContext (SLA config not stored in PG yet — return empty)
    const companyContext: CompanyContext = {
      companyId: companyId.toString(),
      companyName: company.name,
      status: "Active",
      aiPromptTemplate: "",
      projects,
      slaConfig: [],
    };

    // 5. Find open conversation
    const convResult = await pool.query(
      `SELECT id, status, handled_by
       FROM conversations
       WHERE identity_id = $1 AND channel = $2 AND status = 'open'
       ORDER BY created_at DESC
       LIMIT 1`,
      [identity.identity_id, channel],
    );

    const conversationId =
      convResult.rows.length > 0 ? convResult.rows[0].id.toString() : "";
    const status =
      convResult.rows.length > 0 ? convResult.rows[0].status : "open";
    const handledBy =
      convResult.rows.length > 0 ? convResult.rows[0].handled_by : "ai";

    return {
      sessionId: randomUUID(),
      companyId: companyId.toString(),
      conversationId,
      customerRef: senderId,
      companyContext,
      status: status as "open" | "closed",
      handledBy: handledBy as "ai" | "human",
    };
  }

  // ─── Conversation History ─────────────────────────────────

  async getConversationHistory(
    conversationId: string,
    limit: number = 50,
  ): Promise<any[]> {
    const { rows } = await pool.query(
      `SELECT * FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [conversationId, limit],
    );
    return rows.map((r: any) => ({ ...r, id: r.id.toString() }));
  }

  // ─── Handoff State ────────────────────────────────────────

  async updateHandoffState(
    conversationId: string,
    handledBy: "ai" | "human",
  ): Promise<void> {
    await pool.query(
      `UPDATE conversations SET handled_by = $1, updated_at = NOW() WHERE id = $2`,
      [handledBy, conversationId],
    );
  }

  // ─── Knowledge Search ─────────────────────────────────────

  async searchKnowledge(
    query: string,
    filters?: { projectId?: string },
  ): Promise<any[]> {
    const results: any[] = [];

    // Search messages
    const msgQuery = `
      SELECT m.id, m.content, m.conversation_id, 'message' AS type
      FROM messages m
      WHERE m.content ILIKE '%' || $1 || '%'
      ORDER BY m.created_at DESC
      LIMIT 10`;
    const msgResult = await pool.query(msgQuery, [query]);

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

    // Search tickets (subject + summary)
    let ticketQuery: string;
    let ticketParams: any[];

    if (filters?.projectId) {
      ticketQuery = `
        SELECT t.id, t.ticket_id, t.subject, t.summary, t.conversation_id, 'ticket' AS type
        FROM tickets t
        JOIN conversations c ON c.id = t.conversation_id
        WHERE (t.subject ILIKE '%' || $1 || '%' OR t.summary ILIKE '%' || $1 || '%')
          AND c.project_id = $2
        ORDER BY t.created_at DESC
        LIMIT 10`;
      ticketParams = [query, filters.projectId];
    } else {
      ticketQuery = `
        SELECT t.id, t.ticket_id, t.subject, t.summary, 'ticket' AS type
        FROM tickets t
        WHERE t.subject ILIKE '%' || $1 || '%' OR t.summary ILIKE '%' || $1 || '%'
        ORDER BY t.created_at DESC
        LIMIT 10`;
      ticketParams = [query];
    }

    const ticketResult = await pool.query(ticketQuery, ticketParams);

    for (const row of ticketResult.rows) {
      results.push({
        source: "postgres",
        id: row.id.toString(),
        type: "ticket",
        content: `${row.subject ?? ""} — ${row.summary ?? ""}`,
        confidence: 0.8,
        metadata: { ticketId: row.ticket_id },
      });
    }

    return results;
  }

  // ─── Traces ────────────────────────────────────────────────

  async saveTrace(trace: AuditLog): Promise<void> {
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
      ],
    );
  }

  async getTrace(traceId: string): Promise<AuditLog | null> {
    const { rows } = await pool.query(
      `SELECT * FROM traces WHERE trace_id = $1 LIMIT 1`,
      [traceId],
    );
    if (rows.length === 0) return null;
    return this.mapRowToAuditLog(rows[0]);
  }

  async listTraces(sessionId: string): Promise<AuditLog[]> {
    const { rows } = await pool.query(
      `SELECT * FROM traces WHERE session_id = $1 ORDER BY called_at ASC`,
      [sessionId],
    );
    return rows.map((r: any) => this.mapRowToAuditLog(r));
  }

  async listAllTraces(): Promise<AuditLog[]> {
    const { rows } = await pool.query(
      `SELECT * FROM traces ORDER BY called_at ASC`,
    );
    return rows.map((r: any) => this.mapRowToAuditLog(r));
  }

  // ─── Helpers ───────────────────────────────────────────────

  private mapRowToAuditLog(row: any): AuditLog {
    return {
      traceId: row.trace_id,
      sessionId: row.session_id,
      agentId: row.agent_id ?? undefined,
      toolName: row.tool_name,
      calledAt: row.called_at instanceof Date ? row.called_at.toISOString() : row.called_at,
      reason: row.reason ?? undefined,
      arguments: typeof row.arguments === "string" ? JSON.parse(row.arguments) : (row.arguments ?? {}),
      result: row.result ? (typeof row.result === "string" ? JSON.parse(row.result) : row.result) : undefined,
      status: row.status,
      errorMessage: row.error_message ?? undefined,
      completedAt: row.completed_at
        ? (row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at)
        : undefined,
      requestId: row.request_id ?? undefined,
      conversationId: row.conversation_id ?? undefined,
      parentTraceId: row.parent_trace_id ?? undefined,
    };
  }
}
