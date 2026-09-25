import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { resolveProjectFilter, canAccessProject } from "../../middleware/tenantScope";
import { auditService } from "../../services/AuditService";
import { createLogger } from "../../observability/logger";

const logger = createLogger("dlq-admin-api");

/**
 * outbox_events has no project_id column in the live schema (it was never
 * migrated); the project travels in the payload. Non-numeric or absent values
 * yield NULL, which only unrestricted callers can see (SEC-01).
 */
const OUTBOX_PROJECT_ID_SQL = `(CASE WHEN payload->>'projectId' ~ '^[0-9]+$' THEN (payload->>'projectId')::int END)`;

const SENSITIVE_PAYLOAD_KEYS = new Set([
  "authorization",
  "token",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "apikey",
  "api_key",
  "secret",
  "password",
  "client_secret",
]);

function maskSensitivePayload(data: any, depth = 0): any {
  if (data === null || data === undefined) return null;
  if (depth > 6) return "[Truncated]";
  if (typeof data !== "object") return data;

  if (Array.isArray(data)) {
    return data.slice(0, 50).map((x) => maskSensitivePayload(x, depth + 1));
  }

  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SENSITIVE_PAYLOAD_KEYS.has(k.toLowerCase())) {
      result[k] = "******";
    } else if (typeof v === "object" && v !== null) {
      result[k] = maskSensitivePayload(v, depth + 1);
    } else {
      result[k] = v;
    }
  }
  return result;
}

export async function registerDlqAdminRoutes(fastify: FastifyInstance): Promise<void> {
  // 1. GET /api/admin/outbox/dead-letters
  fastify.get("/api/admin/outbox/dead-letters", async (request, reply) => {
    const query = (request.query || {}) as {
      projectId?: string;
      limit?: string;
      offset?: string;
      failureKind?: string;
      eventType?: string;
    };

    const filter = resolveProjectFilter(request, reply, query.projectId);
    if (!filter) return;

    const limit = Math.min(Math.max(parseInt(query.limit || "25", 10) || 25, 1), 100);
    const offset = Math.max(parseInt(query.offset || "0", 10) || 0, 0);

    const conditions: string[] = ["(status = 'dead_letter' OR status = 'failed')"];
    const values: any[] = [];
    let idx = 1;

    if (filter.projectIds !== null) {
      conditions.push(`${OUTBOX_PROJECT_ID_SQL} = ANY($${idx}::int[])`);
      values.push(filter.projectIds);
      idx++;
    }

    if (query.failureKind) {
      conditions.push(`failure_kind = $${idx}`);
      values.push(query.failureKind);
      idx++;
    }

    if (query.eventType) {
      conditions.push(`event_type = $${idx}`);
      values.push(query.eventType);
      idx++;
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const countRes = await pool.query(
      `SELECT count(*)::int AS total FROM outbox_events ${whereClause}`,
      values
    );
    const total = Number(countRes.rows[0]?.total || 0);

    const dataSql = `
      SELECT id, aggregate_type, aggregate_id, event_type, payload, status, attempts,
             failure_kind, error_message, ${OUTBOX_PROJECT_ID_SQL} AS project_id, created_at, updated_at, dead_lettered_at
      FROM outbox_events
      ${whereClause}
      ORDER BY dead_lettered_at DESC NULLS LAST, id DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    values.push(limit, offset);

    const dataRes = await pool.query(dataSql, values);
    const deadLetters = dataRes.rows.map((r: any) => ({
      id: Number(r.id),
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      eventType: r.event_type,
      payload: maskSensitivePayload(typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload),
      status: r.status,
      attempts: Number(r.attempts || 0),
      failureKind: r.failure_kind || "unknown",
      errorMessage: r.error_message || null,
      projectId: r.project_id !== null ? Number(r.project_id) : null,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      deadLetteredAt: r.dead_lettered_at instanceof Date ? r.dead_lettered_at.toISOString() : r.dead_lettered_at ? String(r.dead_lettered_at) : null,
    }));

    return reply.send({ success: true, deadLetters, total, limit, offset });
  });

  // 2. GET /api/admin/outbox/dead-letters/:id
  fastify.get("/api/admin/outbox/dead-letters/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const id = parseInt(params.id, 10);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: "Bad Request", message: "Invalid dead letter id" });
    }

    const res = await pool.query(
      `SELECT id, aggregate_type, aggregate_id, event_type, payload, status, attempts,
              failure_kind, error_message, ${OUTBOX_PROJECT_ID_SQL} AS project_id, created_at, updated_at, dead_lettered_at
       FROM outbox_events
       WHERE id = $1 AND (status = 'dead_letter' OR status = 'failed')
       LIMIT 1`,
      [id]
    );

    if (res.rows.length === 0) {
      return reply.status(404).send({ error: "Not Found", message: `Dead letter event ${id} not found` });
    }

    const row = res.rows[0];
    if (!canAccessProject(request, row.project_id)) {
      return reply.status(403).send({ error: "Forbidden", message: "Access to this event is not authorized" });
    }

    const item = {
      id: Number(row.id),
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: maskSensitivePayload(typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload),
      status: row.status,
      attempts: Number(row.attempts || 0),
      failureKind: row.failure_kind || "unknown",
      errorMessage: row.error_message || null,
      projectId: row.project_id !== null ? Number(row.project_id) : null,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      deadLetteredAt: row.dead_lettered_at instanceof Date ? row.dead_lettered_at.toISOString() : row.dead_lettered_at ? String(row.dead_lettered_at) : null,
    };

    return reply.send({ success: true, deadLetter: item });
  });

  // 3. POST /api/admin/outbox/dead-letters/:id/requeue
  fastify.post("/api/admin/outbox/dead-letters/:id/requeue", async (request, reply) => {
    const params = request.params as { id: string };
    const id = parseInt(params.id, 10);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: "Bad Request", message: "Invalid dead letter id" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Load event FOR UPDATE
      const res = await client.query(
        `SELECT id, aggregate_type, aggregate_id, event_type, status, attempts,
                failure_kind, ${OUTBOX_PROJECT_ID_SQL} AS project_id, error_message
         FROM outbox_events
         WHERE id = $1
         FOR UPDATE`,
        [id]
      );

      if (res.rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ error: "Not Found", message: `Outbox event ${id} not found` });
      }

      const row = res.rows[0];

      // 2. Verify project scope
      if (!canAccessProject(request, row.project_id)) {
        await client.query("ROLLBACK");
        return reply.status(403).send({ error: "Forbidden", message: "Access to this event is not authorized" });
      }

      // 3. Verify event is actually in dead-letter status
      if (row.status !== "dead_letter" && row.status !== "failed") {
        await client.query("ROLLBACK");
        return reply.status(400).send({
          error: "Bad Request",
          message: `Cannot requeue event with status '${row.status}'. Must be 'dead_letter' or 'failed'.`,
        });
      }

      // 4. Perform mutation transactionally
      await client.query(
        `UPDATE outbox_events
         SET status = 'pending',
             attempts = 0,
             failure_kind = NULL,
             dead_lettered_at = NULL,
             next_attempt_at = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [id]
      );

      // 5. Create audit record
      const actorName = request.principal?.subject || "operator";
      await auditService.record(
        {
          projectId: row.project_id !== null ? Number(row.project_id) : null,
          action: "DLQ_REQUEUE",
          actor: actorName,
          oldValue: {
            id,
            status: row.status,
            failureKind: row.failure_kind,
            attempts: row.attempts,
            errorMessage: row.error_message,
          },
          newValue: {
            id,
            status: "pending",
            attempts: 0,
          },
        },
        client
      );

      await client.query("COMMIT");

      logger.info({ id, actor: actorName }, "Successfully requeued dead letter outbox event");

      return reply.send({
        success: true,
        message: `Event ${id} requeued to pending successfully`,
        requeuedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      await client.query("ROLLBACK");
      logger.error({ error: err.message, id }, "Failed to requeue dead letter outbox event");
      return reply.status(500).send({ error: "Internal Server Error", message: err.message });
    } finally {
      client.release();
    }
  });
}
