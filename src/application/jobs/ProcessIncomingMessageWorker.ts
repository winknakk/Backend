import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { config } from "../../config/env";
import { createLogger } from "../../observability/logger";
import { runWithContext } from "../../kernel/context/RequestContextHolder";
import { JobPayload } from "../../queue/types";

const logger = createLogger("ProcessIncomingMessageWorker");

export class ProcessIncomingMessageWorker {
  private worker: Worker;
  private redisConnection: Redis;

  constructor(handler: (job: JobPayload) => Promise<any>) {
    this.redisConnection = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null, // Required by BullMQ
      enableOfflineQueue: true,
    });

    this.worker = new Worker(
      "message-queue",
      async (job: Job) => {
        const payload = job.data;
        const jobId = job.id || payload.metadata?.requestId;
        const lockKey = `processed:event:${jobId}`;

        // 1. Idempotency Check
        const setRes = await this.redisConnection.set(lockKey, "processing", "EX", 86400, "NX");
        const acquired = setRes === "OK";
        if (!acquired) {
          logger.warn({ jobId }, "Duplicate event processing bypassed by Idempotency Guard");
          return;
        }

        try {
          // 2. Resolve request context coordinates
          const channel = payload.data?.channel || "LINE";
          const companyId = payload.data?.companyId || "1";
          
          // Fallback project coordinates
          let projectId = "1";
          
          // Re-query database if conversation exists to get its project scope
          try {
            const { pool } = require("../../adapters/postgres/PostgresAdapter");
            const identityRef = payload.data?.senderId;
            if (identityRef) {
              const res = await pool.query(
                `SELECT c.project_id 
                 FROM conversations c
                 JOIN identities i ON i.id = c.identity_id
                 WHERE i.channel_ref = $1 AND LOWER(c.channel) = LOWER($2) AND c.status = 'open'
                 LIMIT 1`,
                [identityRef, channel]
              );
              if (res.rows.length > 0 && res.rows[0].project_id) {
                projectId = String(res.rows[0].project_id);
              }
            }
          } catch (dbErr: any) {
            logger.warn({ error: dbErr.message }, "Could not resolve dynamic project scope for RequestContext, using default");
          }

          // 3. Execute handler cleanly inside RequestContext scope
          const v2Job: JobPayload = {
            jobId: jobId!,
            type: payload.type,
            data: payload.data,
            metadata: payload.metadata,
            status: "RUNNING",
            retryCount: job.attemptsMade,
            maxRetry: job.opts.attempts || 3,
          };

          const result = await runWithContext(
            {
              correlationId: jobId!,
              projectId,
              clientChannel: channel,
              channelRef: payload.data?.senderId || "unknown",
            },
            async () => {
              const res = await handler(v2Job);
              
              // Trigger summary update job asynchronously if there is an active ticket for the conversation
              try {
                const { pool } = require("../../adapters/postgres/PostgresAdapter");
                const { QueueFactory } = require("../../queue/QueueFactory");
                
                // First resolve conversation ID for the sender
                const convRes = await pool.query(
                  `SELECT c.id FROM conversations c
                   JOIN identities i ON i.id = c.identity_id
                   WHERE i.channel_ref = $1 AND LOWER(c.channel) = LOWER($2) AND c.status = 'open'
                   LIMIT 1`,
                  [payload.data?.senderId, channel]
                );
                
                if (convRes.rows.length > 0) {
                  const conversationId = convRes.rows[0].id;
                  const ticketRes = await pool.query(
                    "SELECT id FROM tickets WHERE conversation_id = $1 AND LOWER(status) NOT IN ('closed', 'merged') LIMIT 1",
                    [conversationId]
                  );
                  
                  if (ticketRes.rows.length > 0) {
                    const ticketDbId = ticketRes.rows[0].id;
                    const queue = QueueFactory.getQueue();
                    await queue.enqueue({
                      type: "ticket.summary.update",
                      data: {
                        ticketId: ticketDbId,
                        conversationId,
                        messageText: payload.data?.text || ""
                      },
                      metadata: {
                        requestId: jobId
                      }
                    });
                  }
                }
              } catch (sumErr: any) {
                logger.warn({ error: sumErr.message }, "Could not trigger ticket summary update job");
              }

              return res;
            }
          );

          // 4. Mark lock completed
          await this.redisConnection.set(lockKey, "done", "EX", 86400);
          return result;
        } catch (err: any) {
          // Release lock so retries can process it again
          await this.redisConnection.del(lockKey);
          logger.error({ jobId, error: err.message }, "Error processing job in worker loop");
          throw err; // rethrow to let BullMQ attempts backoff retry
        }
      },
      {
        connection: this.redisConnection as any,
        concurrency: 5,
      }
    );

    // 5. Dead Letter Queue (DLQ) Retry exhaustion handling
    this.worker.on("failed", async (job, err) => {
      if (job && job.attemptsMade >= 3) {
        logger.error(
          { jobId: job.id, attemptsMade: job.attemptsMade, error: err.message },
          "CRITICAL: Job retry budget exhausted. Displacing failure context to DLQ key: queue:jobs:dlq"
        );
        
        try {
          await this.redisConnection.rpush(
            "queue:jobs:dlq",
            JSON.stringify({
              jobId: job.id,
              payload: job.data,
              failedAt: new Date().toISOString(),
              error: err.message,
              attemptsMade: job.attemptsMade,
            })
          );
        } catch (dlqErr: any) {
          logger.error({ error: dlqErr.message }, "Failed to write job state to DLQ list key");
        }
      }
    });

    this.worker.on("error", (err) => {
      logger.error({ error: err.message }, "ProcessIncomingMessageWorker encountered error");
    });
  }

  /**
   * Closes the worker and connection.
   */
  async close(): Promise<void> {
    await this.worker.close();
    await this.redisConnection.quit();
  }
}
