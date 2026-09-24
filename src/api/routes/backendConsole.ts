import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config/env";
import { createLogger } from "../../observability/logger";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { isSlaConsolePrincipal } from "./slaConsole";
import { LineMessageBatchingService } from "../../services/LineMessageBatchingService";
import { AgentSessionQueueService } from "../../services/AgentSessionQueueService";
import { AgentSessionQueueWorker } from "../../services/AgentSessionQueueWorker";
import { SLACadenceService } from "../../services/SLACadenceService";

const logger = createLogger("backend-console");

function consolePagePath(): string {
  return path.resolve(__dirname, "../../../assets/backend-console/index.html");
}

export interface BackendActivityEvent {
  id: string;
  timestamp: string;
  category: "fast-ack" | "webhook" | "batch" | "queue" | "ai" | "system" | "error";
  status: "ok" | "warn" | "error" | "info";
  title: string;
  detail?: string;
  meta?: Record<string, unknown>;
}

// In-memory ring buffer (up to 300 events) for instant, low-latency live streaming
const MAX_BUFFER_EVENTS = 300;
const activityRingBuffer: BackendActivityEvent[] = [];

export function recordBackendActivity(
  event: Omit<BackendActivityEvent, "id" | "timestamp"> & { timestamp?: string }
): BackendActivityEvent {
  const item: BackendActivityEvent = {
    id: randomUUID(),
    timestamp: event.timestamp || new Date().toISOString(),
    category: event.category,
    status: event.status,
    title: event.title,
    detail: event.detail,
    meta: event.meta,
  };

  activityRingBuffer.unshift(item);
  if (activityRingBuffer.length > MAX_BUFFER_EVENTS) {
    activityRingBuffer.length = MAX_BUFFER_EVENTS;
  }
  return item;
}

// Pre-record system boot or module load event
recordBackendActivity({
  category: "system",
  status: "ok",
  title: "Backend Monitor Online",
  detail: `Node ${process.version} (${process.platform}) · PID ${process.pid}`,
  meta: { nodeVersion: process.version, pid: process.pid, platform: process.platform },
});

async function requireBackendConsoleAccess(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!config.API_KEY) {
    await reply.code(503).send({ success: false, error: "Backend console API is disabled until API_KEY is configured" });
    return;
  }
  if (!isSlaConsolePrincipal(request)) {
    logger.warn({ url: request.url, principal: request.principal?.subject, role: request.principal?.role }, "Backend console access refused");
    await reply.code(403).send({ success: false, code: "SUPER_ADMIN_REQUIRED", error: "Backend monitor requires the service key or a super_admin session" });
  }
}

const adminRouteOptions = { preHandler: requireBackendConsoleAccess };

export interface BackendConsoleServices {
  lineMessageBatchingService?: LineMessageBatchingService;
  agentSessionQueueService?: AgentSessionQueueService;
  agentSessionQueueWorker?: AgentSessionQueueWorker;
  slaCadenceService?: SLACadenceService;
}

export function registerBackendConsoleRoutes(
  fastify: FastifyInstance,
  services: BackendConsoleServices = {}
): void {
  const { lineMessageBatchingService, agentSessionQueueService, slaCadenceService } = services;

  // --- HTML Operator Console (Public media prefix) ---
  fastify.get("/api/v1/media/backend-console", async (_request, reply) => {
    try {
      const html = await fs.promises.readFile(consolePagePath(), "utf8");
      return reply.header("Content-Type", "text/html; charset=utf-8").header("Cache-Control", "no-store").send(html);
    } catch (err: any) {
      logger.error({ error: err.message }, "Backend console page missing");
      return reply.code(404).send("Backend console page not found");
    }
  });

  // --- Overview & System Health ---
  fastify.get("/api/v1/admin/backend-monitor/overview", adminRouteOptions, async (_request, reply) => {
    try {
      const mem = process.memoryUsage();
      const uptimeSec = Math.round(process.uptime());

      // DB Pool stats
      const dbStats = {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      };

      // Notifications today
      const todayNotifsQuery = await pool.query(
        `SELECT notification_type, status, COUNT(*)::int as count 
         FROM customer_notifications 
         WHERE created_at >= CURRENT_DATE 
         GROUP BY notification_type, status`
      ).catch(() => ({ rows: [] }));

      // Queue status counts
      const queueCountsQuery = await pool.query(
        `SELECT status, COUNT(*)::int as count 
         FROM agent_session_queue 
         GROUP BY status`
      ).catch(() => ({ rows: [] }));

      // Batching stats
      const batchStats = {
        pendingCount: lineMessageBatchingService?.getPendingCount() ?? 0,
        activeBatches: lineMessageBatchingService?.getActiveBatchesSummary() ?? [],
      };

      // SLA Engine summary
      const engineState = slaCadenceService?.getEngineState?.() ?? null;

      // Inbound count today (last 24 hours)
      const inboundToday = await pool.query(
        `SELECT COUNT(*)::int as count FROM messages WHERE (role = 'customer' OR sender_type = 'customer') AND created_at >= NOW() - INTERVAL '24 hours'`
      ).catch(() => ({ rows: [{ count: 0 }] }));

      return reply.send({
        success: true,
        data: {
          serverTime: new Date().toISOString(),
          uptimeSeconds: uptimeSec,
          process: {
            pid: process.pid,
            version: process.version,
            platform: process.platform,
            memory: {
              rssMb: Math.round(mem.rss / 1024 / 1024),
              heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
              heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
              externalMb: Math.round(mem.external / 1024 / 1024),
            },
          },
          database: dbStats,
          notificationsToday: todayNotifsQuery.rows,
          queue: queueCountsQuery.rows,
          batching: batchStats,
          inboundTodayCount: inboundToday.rows[0]?.count ?? 0,
          engineState,
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to fetch overview metrics");
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // --- Real-time Activity Events Stream ---
  fastify.get("/api/v1/admin/backend-monitor/events", adminRouteOptions, async (request, reply) => {
    try {
      const q = request.query as any;
      const limit = Math.min(Number(q?.limit) || 100, 300);
      const since = q?.since ? String(q.since) : null;
      const category = q?.category ? String(q.category) : null;

      let events = [...activityRingBuffer];

      if (since) {
        const sinceDate = new Date(since).getTime();
        events = events.filter((e) => new Date(e.timestamp).getTime() > sinceDate);
      }

      if (category && category !== "all") {
        events = events.filter((e) => e.category === category);
      }

      // If buffer has very few events (e.g. freshly restarted), populate with recent DB events
      if (events.length < 10) {
        const recentNotifs = await pool.query(
          `SELECT id, conversation_id, notification_type, status, idempotency_key, error_message, sent_at, created_at, body
           FROM customer_notifications
           ORDER BY id DESC LIMIT 25`
        ).catch(() => ({ rows: [] }));

        for (const row of recentNotifs.rows) {
          const already = events.some((e) => e.meta?.notificationId === row.id);
          if (!already) {
            events.push({
              id: `db-notif-${row.id}`,
              timestamp: row.sent_at || row.created_at,
              category: "fast-ack",
              status: row.status === "sent" ? "ok" : row.status === "failed" ? "error" : "info",
              title: `Fast Ack (${row.notification_type})`,
              detail: row.body ? `"${row.body}"` : `Conv #${row.conversation_id} · Status: ${row.status}`,
              meta: { notificationId: row.id, idempotencyKey: row.idempotency_key, status: row.status, body: row.body },
            });
          }
        }

        // Sort descending by timestamp
        events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      }

      return reply.send({
        success: true,
        data: events.slice(0, limit),
      });
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to fetch activity events");
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // --- Fast Ack & Notifications Inspector ---
  fastify.get("/api/v1/admin/backend-monitor/fast-acks", adminRouteOptions, async (request, reply) => {
    try {
      const limit = Math.min(Number((request.query as any)?.limit) || 50, 100);
      const query = `
        SELECT 
          n.id,
          n.conversation_id,
          n.ticket_id,
          n.notification_type,
          n.status,
          n.idempotency_key,
          n.error_message,
          n.sent_at,
          n.created_at,
          n.body,
          c.project_id
        FROM customer_notifications n
        LEFT JOIN conversations c ON c.id = n.conversation_id
        WHERE n.notification_type IN ('acknowledgement', 'acknowledgement_action', 'acknowledgement_edit', 'greeting', 'thanks', 'waiting_customer', 'progress_update')
        ORDER BY n.id DESC
        LIMIT $1
      `;
      const res = await pool.query(query, [limit]);
      return reply.send({ success: true, data: res.rows });
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to fetch fast acks");
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // --- Inbound Customer Messages ---
  fastify.get("/api/v1/admin/backend-monitor/inbound-messages", adminRouteOptions, async (request, reply) => {
    try {
      const limit = Math.min(Number((request.query as any)?.limit) || 50, 100);
      const query = `
        SELECT 
          m.id,
          m.conversation_id,
          COALESCE(m.message_type, 'text') AS message_type,
          m.role,
          m.sender_type,
          COALESCE(m.content, '') AS text,
          m.created_at,
          m.content_json AS metadata
        FROM messages m
        WHERE m.role = 'customer' OR m.sender_type = 'customer'
        ORDER BY m.id DESC
        LIMIT $1
      `;
      const res = await pool.query(query, [limit]);
      return reply.send({ success: true, data: res.rows });
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to fetch inbound messages");
      return reply.code(500).send({ success: false, error: err.message });
    }
  });


  // --- Agent Session Queue & Batching ---
  fastify.get("/api/v1/admin/backend-monitor/queue", adminRouteOptions, async (request, reply) => {
    try {
      const limit = Math.min(Number((request.query as any)?.limit) || 50, 100);
      const query = `
        SELECT 
          id,
          conversation_id,
          source_event_id,
          channel,
          sender_ref,
          status,
          lease_token,
          lease_expires_at,
          attempt_count,
          error_detail,
          sequence_at,
          created_at,
          updated_at,
          completed_at
        FROM agent_session_queue
        ORDER BY created_at DESC
        LIMIT $1
      `;
      const queueItems = await pool.query(query, [limit]).catch(() => ({ rows: [] }));
      const activeBatches = lineMessageBatchingService?.getActiveBatchesSummary() ?? [];

      return reply.send({
        success: true,
        data: {
          batches: activeBatches,
          queue: queueItems.rows,
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to fetch queue data");
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // --- Traces & Causality Timeline ---
  fastify.get("/api/v1/admin/backend-monitor/traces", adminRouteOptions, async (request, reply) => {
    try {
      const limit = Math.min(Number((request.query as any)?.limit) || 50, 100);
      const query = `
        SELECT 
          id,
          correlation_id,
          parent_correlation_id,
          component,
          event_type,
          status,
          external_execution_id,
          ticket_id,
          conversation_id,
          detail,
          error_message,
          created_at
        FROM trace_events
        ORDER BY id DESC
        LIMIT $1
      `;
      const res = await pool.query(query, [limit]).catch(() => ({ rows: [] }));
      return reply.send({ success: true, data: res.rows });
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to fetch trace events");
      return reply.code(500).send({ success: false, error: err.message });
    }
  });

  // --- Ping / Self-test ---
  fastify.post("/api/v1/admin/backend-monitor/ping", adminRouteOptions, async (_request, reply) => {
    const item = recordBackendActivity({
      category: "system",
      status: "ok",
      title: "Self-Test Ping Received",
      detail: `Operator initiated test ping at ${new Date().toLocaleTimeString("th-TH")}`,
    });
    return reply.send({ success: true, pong: true, timestamp: item.timestamp, eventId: item.id });
  });
}
