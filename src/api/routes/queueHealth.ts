import { FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import { config } from "../../config/env";
import { createLogger } from "../../observability/logger";
import { createRedisClient } from "../../infrastructure/cache/createRedisClient";
import { TicketWorkersManager } from "../../application/jobs/TicketWorkersManager";

const logger = createLogger("queue-health-api");

const KNOWN_QUEUES = [
  { name: "message-queue", workerKey: null },
  { name: "ticket-title-queue", workerKey: "titleWorker" },
  { name: "ticket-summary-queue", workerKey: "summaryWorker" },
  { name: "ticket-duplicate-queue", workerKey: "duplicateWorker" },
  { name: "ticket-plane-sync-queue", workerKey: "planeWorker" },
  { name: "automationx-platform-events-queue", workerKey: null },
  { name: "conversation-intelligence-queue", workerKey: "knowledgeGapWorker" },
];

export async function registerQueueHealthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/admin/queues/health", async (request, reply) => {
    const isRedisProvider = (config.QUEUE_PROVIDER || "").toLowerCase() === "redis";
    const workerStatus = TicketWorkersManager.getStatus() as Record<string, string>;

    if (!isRedisProvider) {
      return reply.send({
        success: true,
        mode: "in-memory",
        redisStatus: "NOT_CONFIGURED",
        queues: KNOWN_QUEUES.map((q) => ({
          name: q.name,
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          workerStatus: q.workerKey && workerStatus[q.workerKey] ? workerStatus[q.workerKey] : "UNKNOWN",
        })),
        workers: workerStatus,
        timestamp: new Date().toISOString(),
      });
    }

    try {
      const redis = createRedisClient("queue-health-inspector", {
        connectTimeout: 2000,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });

      try {
        await redis.connect();
      } catch (connErr: any) {
        logger.warn({ error: connErr.message }, "Redis connection failed during queue health inspection");
        return reply.send({
          success: true,
          mode: "redis",
          redisStatus: "DEGRADED",
          error: "Redis unreachable: " + connErr.message,
          queues: KNOWN_QUEUES.map((q) => ({
            name: q.name,
            waiting: 0,
            active: 0,
            completed: 0,
            failed: 0,
            delayed: 0,
            workerStatus: "UNKNOWN",
          })),
          workers: workerStatus,
          timestamp: new Date().toISOString(),
        });
      }

      const queueStats = await Promise.all(
        KNOWN_QUEUES.map(async (q) => {
          let counts = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
          try {
            const queueInstance = new Queue(q.name, { connection: redis as any });
            const rawCounts = await queueInstance.getJobCounts("waiting", "active", "completed", "failed", "delayed");
            counts = {
              waiting: rawCounts.waiting || 0,
              active: rawCounts.active || 0,
              completed: rawCounts.completed || 0,
              failed: rawCounts.failed || 0,
              delayed: rawCounts.delayed || 0,
            };
            await queueInstance.close().catch(() => {});
          } catch {
            // Ignore error per queue
          }

          let reportedWorker = "UNKNOWN";
          if (q.workerKey && workerStatus[q.workerKey]) {
            reportedWorker = workerStatus[q.workerKey];
          }

          return {
            name: q.name,
            waiting: counts.waiting || 0,
            active: counts.active || 0,
            completed: counts.completed || 0,
            failed: counts.failed || 0,
            delayed: counts.delayed || 0,
            workerStatus: reportedWorker,
          };
        })
      );

      await redis.quit().catch(() => {});

      return reply.send({
        success: true,
        mode: "redis",
        redisStatus: "CONNECTED",
        queues: queueStats,
        workers: workerStatus,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      logger.error({ error: err.message }, "Unexpected error in queue health endpoint");
      return reply.send({
        success: true,
        mode: "redis",
        redisStatus: "DEGRADED",
        error: err.message,
        queues: KNOWN_QUEUES.map((q) => ({
          name: q.name,
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          workerStatus: "UNKNOWN",
        })),
        workers: workerStatus,
        timestamp: new Date().toISOString(),
      });
    }
  });
}
