import { FastifyInstance } from "fastify";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { resolveProjectFilter } from "../../middleware/tenantScope";
import { sanitizeAuditData } from "../../services/AuditService";

export async function registerHandoffAuditRoutes(fastify: FastifyInstance): Promise<void> {
  // 1. GET /api/admin/handoffs/audit
  fastify.get("/api/admin/handoffs/audit", async (request, reply) => {
    const query = (request.query || {}) as {
      projectId?: string;
      operatorId?: string;
      triggerType?: string;
      dateFrom?: string;
      dateTo?: string;
      limit?: string;
      offset?: string;
    };

    const filter = resolveProjectFilter(request, reply, query.projectId);
    if (!filter) return;

    const limit = Math.min(Math.max(parseInt(query.limit || "25", 10) || 25, 1), 100);
    const offset = Math.max(parseInt(query.offset || "0", 10) || 0, 0);

    const conditions: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (filter.projectIds !== null) {
      conditions.push(`h.project_id = ANY($${idx}::int[])`);
      values.push(filter.projectIds);
      idx++;
    }

    if (query.operatorId) {
      const opId = parseInt(query.operatorId, 10);
      if (Number.isInteger(opId)) {
        conditions.push(`(h.to_operator_id = $${idx} OR h.from_operator_id = $${idx})`);
        values.push(opId);
        idx++;
      }
    }

    if (query.triggerType) {
      conditions.push(`h.trigger_type = $${idx}`);
      values.push(query.triggerType);
      idx++;
    }

    if (query.dateFrom) {
      conditions.push(`h.started_at >= $${idx}::timestamptz`);
      values.push(query.dateFrom);
      idx++;
    }

    if (query.dateTo) {
      conditions.push(`h.started_at <= $${idx}::timestamptz`);
      values.push(query.dateTo);
      idx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countSql = `SELECT count(*)::int AS total FROM conversation_handoffs h ${whereClause}`;
    const countRes = await pool.query(countSql, values);
    const total = Number(countRes.rows[0]?.total || 0);

    const dataSql = `
      SELECT h.id, h.conversation_id, h.project_id, h.from_owner, h.to_owner,
             h.from_operator_id, h.to_operator_id, h.trigger_type, h.reason,
             h.started_at, h.ended_at, h.context_snapshot,
             ROUND(EXTRACT(EPOCH FROM (COALESCE(h.ended_at, NOW()) - h.started_at)))::int AS duration_seconds,
             o_to.email AS to_operator_email, o_to.name AS to_operator_name,
             o_from.email AS from_operator_email, o_from.name AS from_operator_name
      FROM conversation_handoffs h
      LEFT JOIN operators o_to ON o_to.id = h.to_operator_id
      LEFT JOIN operators o_from ON o_from.id = h.from_operator_id
      ${whereClause}
      ORDER BY h.started_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    values.push(limit, offset);

    const dataRes = await pool.query(dataSql, values);
    const handoffs = dataRes.rows.map((r: any) => ({
      id: Number(r.id),
      conversationId: Number(r.conversation_id),
      projectId: Number(r.project_id),
      fromOwner: r.from_owner,
      toOwner: r.to_owner,
      fromOperatorId: r.from_operator_id ? Number(r.from_operator_id) : null,
      fromOperatorName: r.from_operator_name || r.from_operator_email || null,
      toOperatorId: r.to_operator_id ? Number(r.to_operator_id) : null,
      toOperatorName: r.to_operator_name || r.to_operator_email || null,
      triggerType: r.trigger_type,
      reason: r.reason,
      startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at),
      endedAt: r.ended_at instanceof Date ? r.ended_at.toISOString() : r.ended_at ? String(r.ended_at) : null,
      durationSeconds: Number(r.duration_seconds || 0),
      contextSnapshot: sanitizeAuditData(typeof r.context_snapshot === "string" ? JSON.parse(r.context_snapshot) : r.context_snapshot || {}),
    }));

    return reply.send({ success: true, handoffs, total, limit, offset });
  });

  // 2. GET /api/admin/takeover-sessions
  fastify.get("/api/admin/takeover-sessions", async (request, reply) => {
    const query = (request.query || {}) as {
      projectId?: string;
      operatorId?: string;
      status?: string;
      limit?: string;
      offset?: string;
    };

    const filter = resolveProjectFilter(request, reply, query.projectId);
    if (!filter) return;

    const limit = Math.min(Math.max(parseInt(query.limit || "25", 10) || 25, 1), 100);
    const offset = Math.max(parseInt(query.offset || "0", 10) || 0, 0);

    const conditions: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (filter.projectIds !== null) {
      conditions.push(`ts.project_id = ANY($${idx}::int[])`);
      values.push(filter.projectIds);
      idx++;
    }

    if (query.operatorId) {
      const opId = parseInt(query.operatorId, 10);
      if (Number.isInteger(opId)) {
        conditions.push(`ts.operator_id = $${idx}`);
        values.push(opId);
        idx++;
      }
    }

    if (query.status) {
      conditions.push(`ts.status = $${idx}`);
      values.push(query.status);
      idx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countSql = `SELECT count(*)::int AS total FROM takeover_sessions ts ${whereClause}`;
    const countRes = await pool.query(countSql, values);
    const total = Number(countRes.rows[0]?.total || 0);

    const dataSql = `
      SELECT ts.id, ts.conversation_id, ts.operator_id, ts.project_id, ts.status,
             ts.acquired_at, ts.expires_at, ts.released_at, ts.release_reason, ts.notes,
             ROUND(EXTRACT(EPOCH FROM (COALESCE(ts.released_at, NOW()) - ts.acquired_at)))::int AS duration_seconds,
             o.name AS operator_name, o.email AS operator_email
      FROM takeover_sessions ts
      LEFT JOIN operators o ON o.id = ts.operator_id
      ${whereClause}
      ORDER BY ts.acquired_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    values.push(limit, offset);

    const dataRes = await pool.query(dataSql, values);
    const sessions = dataRes.rows.map((r: any) => ({
      id: Number(r.id),
      conversationId: Number(r.conversation_id),
      operatorId: Number(r.operator_id),
      operatorName: r.operator_name || r.operator_email || "Operator",
      projectId: Number(r.project_id),
      status: r.status,
      acquiredAt: r.acquired_at instanceof Date ? r.acquired_at.toISOString() : String(r.acquired_at),
      expiresAt: r.expires_at instanceof Date ? r.expires_at.toISOString() : String(r.expires_at),
      releasedAt: r.released_at instanceof Date ? r.released_at.toISOString() : r.released_at ? String(r.released_at) : null,
      releaseReason: r.release_reason || null,
      notes: r.notes || null,
      durationSeconds: Number(r.duration_seconds || 0),
    }));

    return reply.send({ success: true, sessions, total, limit, offset });
  });
}
