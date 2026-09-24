import { FastifyInstance } from "fastify";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { resolveProjectFilter } from "../../middleware/tenantScope";

export interface SafeTraceTelemetryItem {
  id: number;
  traceId: string;
  conversationId: number | null;
  projectId: number | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  guardrailStatus: string;
  finalAction: string | null;
  confidenceScore: number | null;
  createdAt: string;
  toolCalls?: Array<{
    toolName: string;
    durationMs: number;
    status: string;
    error?: string | null;
  }>;
}

export async function registerAiObservabilityRoutes(fastify: FastifyInstance): Promise<void> {
  // 1. GET /api/admin/ai/traces/telemetry
  fastify.get("/api/admin/ai/traces/telemetry", async (request, reply) => {
    const query = (request.query || {}) as {
      projectId?: string;
      modelName?: string;
      guardrailStatus?: string;
      minLatency?: string;
      limit?: string;
      offset?: string;
    };

    const filter = resolveProjectFilter(request, reply, query.projectId);
    if (!filter) return;

    const limit = Math.min(Math.max(parseInt(query.limit || "25", 10) || 25, 1), 100);
    const offset = Math.max(parseInt(query.offset || "0", 10) || 0, 0);

    // 1. Check if ai_thinking_traces table has data
    let hasAiThinkingTraces = false;
    try {
      const checkRes = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_thinking_traces' LIMIT 1`
      );
      if (checkRes.rows.length > 0) {
        hasAiThinkingTraces = true;
      }
    } catch {
      hasAiThinkingTraces = false;
    }

    if (hasAiThinkingTraces) {
      const conditions: string[] = [];
      const values: any[] = [];
      let idx = 1;

      if (filter.projectIds !== null) {
        conditions.push(`project_id = ANY($${idx}::int[])`);
        values.push(filter.projectIds);
        idx++;
      }

      if (query.modelName) {
        conditions.push(`model_name = $${idx}`);
        values.push(query.modelName);
        idx++;
      }

      if (query.guardrailStatus) {
        conditions.push(`guardrail_result = $${idx}`);
        values.push(query.guardrailStatus);
        idx++;
      }

      if (query.minLatency) {
        const minL = parseInt(query.minLatency, 10);
        if (Number.isInteger(minL)) {
          conditions.push(`latency_ms >= $${idx}`);
          values.push(minL);
          idx++;
        }
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const countSql = `SELECT count(*)::int AS total FROM ai_thinking_traces ${whereClause}`;
      const countRes = await pool.query(countSql, values);
      const total = Number(countRes.rows[0]?.total || 0);

      // Explicitly query ONLY safe telemetry fields; NEVER query thinking_content or reasoning_steps
      const dataSql = `
        SELECT id, trace_id, conversation_id, project_id,
               COALESCE(input_tokens, 0) AS input_tokens,
               COALESCE(output_tokens, 0) AS output_tokens,
               COALESCE(latency_ms, 0) AS latency_ms,
               COALESCE(model_name, 'gpt-4o') AS model_name,
               COALESCE(guardrail_result, 'pass') AS guardrail_result,
               final_action,
               confidence_score,
               created_at
        FROM ai_thinking_traces
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}
      `;
      values.push(limit, offset);

      const dataRes = await pool.query(dataSql, values);
      const telemetry: SafeTraceTelemetryItem[] = dataRes.rows.map((r: any) => ({
        id: Number(r.id),
        traceId: String(r.trace_id),
        conversationId: r.conversation_id ? Number(r.conversation_id) : null,
        projectId: r.project_id ? Number(r.project_id) : null,
        model: r.model_name,
        promptTokens: Number(r.input_tokens),
        completionTokens: Number(r.output_tokens),
        totalTokens: Number(r.input_tokens) + Number(r.output_tokens),
        latencyMs: Number(r.latency_ms),
        guardrailStatus: r.guardrail_result,
        finalAction: r.final_action || null,
        confidenceScore: r.confidence_score ? Number(r.confidence_score) : null,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      }));

      return reply.send({ success: true, telemetry, total, limit, offset });
    }

    // Fallback: Query tool traces from traces table
    const traceConditions: string[] = [];
    const traceValues: any[] = [];
    let tIdx = 1;

    // Filter by conversation belonging to authorized projects
    if (filter.projectIds !== null) {
      traceConditions.push(`
        t.conversation_id IN (
          SELECT id::text FROM conversations WHERE project_id = ANY($${tIdx}::int[])
        )
      `);
      traceValues.push(filter.projectIds);
      tIdx++;
    }

    const whereTrace = traceConditions.length > 0 ? `WHERE ${traceConditions.join(" AND ")}` : "";

    const countSql = `SELECT count(*)::int AS total FROM traces t ${whereTrace}`;
    const countRes = await pool.query(countSql, traceValues);
    const total = Number(countRes.rows[0]?.total || 0);

    const dataSql = `
      SELECT t.id, t.trace_id, t.conversation_id, t.tool_name, t.called_at, t.completed_at,
             t.status, t.error_message,
             ROUND(EXTRACT(EPOCH FROM (COALESCE(t.completed_at, t.called_at) - t.called_at)) * 1000)::int AS latency_ms
      FROM traces t
      ${whereTrace}
      ORDER BY t.called_at DESC
      LIMIT $${tIdx} OFFSET $${tIdx + 1}
    `;
    traceValues.push(limit, offset);

    const dataRes = await pool.query(dataSql, traceValues);
    const telemetry: SafeTraceTelemetryItem[] = dataRes.rows.map((r: any) => ({
      id: Number(r.id),
      traceId: String(r.trace_id),
      conversationId: r.conversation_id && /^[0-9]+$/.test(r.conversation_id) ? parseInt(r.conversation_id, 10) : null,
      projectId: filter.projectIds && filter.projectIds.length === 1 ? filter.projectIds[0] : null,
      model: "tool-executor",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs: Number(r.latency_ms || 0),
      guardrailStatus: r.status === "ERROR" ? "warn" : "pass",
      finalAction: r.tool_name,
      confidenceScore: null,
      createdAt: r.called_at instanceof Date ? r.called_at.toISOString() : String(r.called_at),
      toolCalls: [
        {
          toolName: r.tool_name,
          durationMs: Number(r.latency_ms || 0),
          status: r.status || "COMPLETED",
          error: r.error_message || null,
        },
      ],
    }));

    return reply.send({ success: true, telemetry, total, limit, offset });
  });

  // 2. GET /api/admin/ai/traces/telemetry/:traceId
  fastify.get("/api/admin/ai/traces/telemetry/:traceId", async (request, reply) => {
    const params = request.params as { traceId: string };
    const traceId = params.traceId;

    // Try finding in ai_thinking_traces
    try {
      const res = await pool.query(
        `SELECT id, trace_id, conversation_id, project_id,
                COALESCE(input_tokens, 0) AS input_tokens,
                COALESCE(output_tokens, 0) AS output_tokens,
                COALESCE(latency_ms, 0) AS latency_ms,
                COALESCE(model_name, 'gpt-4o') AS model_name,
                COALESCE(guardrail_result, 'pass') AS guardrail_result,
                final_action,
                confidence_score,
                tool_calls,
                created_at
         FROM ai_thinking_traces
         WHERE trace_id::text = $1 OR id::text = $1
         LIMIT 1`,
        [traceId]
      );

      if (res.rows.length > 0) {
        const r = res.rows[0];
        const rawTools = typeof r.tool_calls === "string" ? JSON.parse(r.tool_calls) : r.tool_calls || [];
        const safeTools = Array.isArray(rawTools)
          ? rawTools.map((tc: any) => ({
              toolName: String(tc.name || tc.toolName || "tool"),
              durationMs: Number(tc.durationMs || 0),
              status: String(tc.status || "SUCCESS"),
              error: tc.error ? String(tc.error) : null,
            }))
          : [];

        return reply.send({
          success: true,
          telemetry: {
            id: Number(r.id),
            traceId: String(r.trace_id),
            conversationId: r.conversation_id ? Number(r.conversation_id) : null,
            projectId: r.project_id ? Number(r.project_id) : null,
            model: r.model_name,
            promptTokens: Number(r.input_tokens),
            completionTokens: Number(r.output_tokens),
            totalTokens: Number(r.input_tokens) + Number(r.output_tokens),
            latencyMs: Number(r.latency_ms),
            guardrailStatus: r.guardrail_result,
            finalAction: r.final_action || null,
            confidenceScore: r.confidence_score ? Number(r.confidence_score) : null,
            createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
            toolCalls: safeTools,
          },
        });
      }
    } catch {
      // Table may not exist or error, fallback to traces
    }

    // Fallback: search traces table
    const traceRes = await pool.query(
      `SELECT t.id, t.trace_id, t.conversation_id, t.tool_name, t.called_at, t.completed_at,
              t.status, t.error_message,
              ROUND(EXTRACT(EPOCH FROM (COALESCE(t.completed_at, t.called_at) - t.called_at)) * 1000)::int AS latency_ms
       FROM traces t
       WHERE t.trace_id::text = $1 OR t.id::text = $1
       LIMIT 1`,
      [traceId]
    );

    if (traceRes.rows.length === 0) {
      return reply.status(404).send({ error: "Not Found", message: `Trace ${traceId} not found` });
    }

    const tr = traceRes.rows[0];
    return reply.send({
      success: true,
      telemetry: {
        id: Number(tr.id),
        traceId: String(tr.trace_id),
        conversationId: tr.conversation_id && /^[0-9]+$/.test(tr.conversation_id) ? parseInt(tr.conversation_id, 10) : null,
        projectId: null,
        model: "tool-executor",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: Number(tr.latency_ms || 0),
        guardrailStatus: tr.status === "ERROR" ? "warn" : "pass",
        finalAction: tr.tool_name,
        confidenceScore: null,
        createdAt: tr.called_at instanceof Date ? tr.called_at.toISOString() : String(tr.called_at),
        toolCalls: [
          {
            toolName: tr.tool_name,
            durationMs: Number(tr.latency_ms || 0),
            status: tr.status || "COMPLETED",
            error: tr.error_message || null,
          },
        ],
      },
    });
  });
}
