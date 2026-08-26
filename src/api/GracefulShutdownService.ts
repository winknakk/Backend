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

    /**
     * Operational errors that reflect a peer going away rather than a bug in
     * this process. A dropped client connection must not take the API down.
     *
     * Observed in production: a single `read ECONNRESET` with no listener
     * became an unhandled 'error' event and terminated the whole server while
     * it was serving requests.
     */
    const RECOVERABLE_ERROR_CODES = new Set([
      "ECONNRESET",
      "EPIPE",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ECONNABORTED",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ERR_STREAM_PREMATURE_CLOSE",
    ]);

    process.on("uncaughtException", (err: any) => {
      const code = err?.code;

      if (RECOVERABLE_ERROR_CODES.has(code)) {
        logger.warn(
          { code, error: err?.message, syscall: err?.syscall },
          "Recovered from uncaught network error; server continues"
        );
        return;
      }

      // Anything else leaves the process in an unknown state. Log it fully,
      // then shut down in an orderly way rather than dying mid-request.
      logger.fatal(
        { code, error: err?.message, stack: err?.stack },
        "Uncaught exception; shutting down gracefully"
      );
      void handleShutdown("uncaughtException");
    });

    process.on("unhandledRejection", (reason: any) => {
      // Never fatal: an unawaited background promise (an outbox retry, a
      // notification send) must not be able to kill the API.
      logger.error(
        { error: reason?.message || String(reason), stack: reason?.stack },
        "Unhandled promise rejection"
      );
    });

    // Malformed HTTP on a raw connection (port scans, TLS to a plaintext
    // port). Node emits this on the server; without a listener it can surface
    // as an uncaught exception.
    fastify.server.on("clientError", (err: any, socket: any) => {
      logger.debug({ error: err?.message }, "Client connection error");
      if (socket && !socket.destroyed) {
        socket.destroy();
      }
    });
  }
}
