import { FastifyInstance } from "fastify";
import { createLogger } from "../observability/logger";
import { pool, replicaPool } from "../adapters/postgres/PostgresAdapter";
import { CacheService } from "../cache/CacheService";
import { QueueFactory } from "../queue/QueueFactory";
import { stopConfigWatcher } from "../cache/ConfigWatcher";

const logger = createLogger("GracefulShutdownService");

export class GracefulShutdownService {
  private static isShuttingDown = false;

  static checkShuttingDown(): boolean {
    return this.isShuttingDown;
  }

  static register(fastify: FastifyInstance) {
    const handleShutdown = async (signal: string) => {
      if (this.isShuttingDown) {
        logger.info(`Received ${signal} but already shutting down. Ignoring.`);
        return;
      }
      this.isShuttingDown = true;
      logger.warn(`Received ${signal}. Starting graceful shutdown...`);

      // Stop config watcher
      try {
        stopConfigWatcher();
      } catch (err: any) {
        logger.error({ error: err.message }, "Error stopping config watcher during shutdown");
      }

      // Close Fastify HTTP server so it stops accepting new requests
      try {
        await fastify.close();
        logger.info("HTTP server closed.");
      } catch (err: any) {
        logger.error({ error: err.message }, "Error closing Fastify server");
      }

      // Drain/disconnect Job Queue
      try {
        const jobQueue = QueueFactory.getQueue();
        if (typeof (jobQueue as any).disconnect === "function") {
          await (jobQueue as any).disconnect();
          logger.info("Job queue disconnected.");
        }
      } catch (err: any) {
        logger.error({ error: err.message }, "Error disconnecting job queue");
      }

      // Disconnect CacheService
      try {
        await CacheService.getInstance().disconnect();
        logger.info("CacheService disconnected.");
      } catch (err: any) {
        logger.error({ error: err.message }, "Error disconnecting cache");
      }

      // Close database pools
      try {
        if (replicaPool && replicaPool !== pool) {
          await replicaPool.end();
          logger.info("Replica DB pool ended.");
        }
        await pool.end();
        logger.info("Primary DB pool ended.");
      } catch (err: any) {
        logger.error({ error: err.message }, "Error ending database pools");
      }

      logger.info("Graceful shutdown complete. Exiting process.");
      process.exit(0);
    };

    process.on("SIGINT", () => handleShutdown("SIGINT"));
    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  }
}
