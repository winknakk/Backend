import { Pool, PoolClient } from "pg";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { createLogger } from "../observability/logger";

const logger = createLogger("audit-service");

export interface AuditEntry {
  projectId: number | null;
  action: string;
  actor: string;
  operatorId?: number | null;
  oldValue?: Record<string, any> | null;
  newValue?: Record<string, any> | null;
}

export interface AuditLogRecord {
  id: number;
  projectId: number | null;
  action: string;
  oldValue: Record<string, any> | null;
  newValue: Record<string, any> | null;
  actor: string;
  timestamp: string;
  operatorId: number | null;
}

const REDACTED_KEYS = new Set([
  "password",
  "token",
  "secret",
  "authorization",
  "apikey",
  "api_key",
  "thinking",
  "chain_of_thought",
  "reasoning_steps",
  "thinking_content",
  "cookie",
]);

/**
 * Recursively redacts sensitive values and strips internal AI reasoning.
 */
export function sanitizeAuditData(data: any, depth = 0): any {
  if (data === null || data === undefined) return null;
  if (depth > 6) return "[Truncated: Max Depth]";

  if (typeof data !== "object") {
    return data;
  }

  if (Array.isArray(data)) {
    return data.slice(0, 50).map((item) => sanitizeAuditData(item, depth + 1));
  }

  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (REDACTED_KEYS.has(lowerKey)) {
      clean[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      clean[key] = sanitizeAuditData(value, depth + 1);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

export class AuditService {
  private dbPool: Pool;

  constructor(customPool?: Pool) {
    this.dbPool = customPool || pool;
  }

  /**
   * Records an administrative action in admin_audit_logs.
   * If a client is provided, writes within that transaction.
   */
  async record(entry: AuditEntry, client?: PoolClient): Promise<number | null> {
    const executor = client || this.dbPool;
    try {
      const sanitizedOld = sanitizeAuditData(entry.oldValue || {});
      const sanitizedNew = sanitizeAuditData(entry.newValue || {});
      const actorName = String(entry.actor || "system").slice(0, 255);
      const actionName = String(entry.action || "UNKNOWN").slice(0, 100);

      const res = await executor.query(
        `INSERT INTO admin_audit_logs (project_id, action, old_value, new_value, actor, operator_id, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING id`,
        [
          entry.projectId !== undefined && entry.projectId !== null ? Number(entry.projectId) : null,
          actionName,
          JSON.stringify(sanitizedOld),
          JSON.stringify(sanitizedNew),
          actorName,
          entry.operatorId !== undefined && entry.operatorId !== null ? Number(entry.operatorId) : null,
        ]
      );

      const id = res.rows[0]?.id ? Number(res.rows[0].id) : null;
      return id;
    } catch (err: any) {
      logger.error({ error: err.message, action: entry.action }, "Failed to write admin audit log");
      return null;
    }
  }

  /**
   * Queries admin_audit_logs with bounded pagination and strict tenant project scoping.
   */
  async queryLogs(params: {
    projectIds: number[] | null;
    action?: string;
    operatorId?: number;
    limit?: number;
    offset?: number;
  }): Promise<{ logs: AuditLogRecord[]; total: number }> {
    const limit = Math.min(Math.max(Number(params.limit) || 25, 1), 100);
    const offset = Math.max(Number(params.offset) || 0, 0);

    const conditions: string[] = [];
    const values: any[] = [];
    let idx = 1;

    // Strict project scoping: null means unrestricted caller (super_admin)
    if (params.projectIds !== null) {
      conditions.push(`project_id = ANY($${idx}::int[])`);
      values.push(params.projectIds);
      idx++;
    }

    if (params.action) {
      conditions.push(`action = $${idx}`);
      values.push(params.action);
      idx++;
    }

    if (params.operatorId) {
      conditions.push(`operator_id = $${idx}::int`);
      values.push(params.operatorId);
      idx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countSql = `SELECT count(*)::int AS total FROM admin_audit_logs ${whereClause}`;
    const countRes = await this.dbPool.query(countSql, values);
    const total = Number(countRes.rows[0]?.total || 0);

    const dataSql = `
      SELECT id, project_id, action, old_value, new_value, actor, operator_id, timestamp
      FROM admin_audit_logs
      ${whereClause}
      ORDER BY id DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    values.push(limit, offset);

    const dataRes = await this.dbPool.query(dataSql, values);
    const logs: AuditLogRecord[] = dataRes.rows.map((r: any) => ({
      id: Number(r.id),
      projectId: r.project_id !== null ? Number(r.project_id) : null,
      action: r.action,
      oldValue: typeof r.old_value === "string" ? JSON.parse(r.old_value) : r.old_value,
      newValue: typeof r.new_value === "string" ? JSON.parse(r.new_value) : r.new_value,
      actor: r.actor,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp),
      operatorId: r.operator_id !== null ? Number(r.operator_id) : null,
    }));

    return { logs, total };
  }
}

export const auditService = new AuditService();
