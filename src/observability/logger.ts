import pino from "pino";
import { config } from "../config/env";

const rootLogger = pino({
  level: config.LOG_LEVEL || "info",
  mixin() {
    return {
      requestId: null,
      conversationId: null,
      traceId: null,
      component: null,
      durationMs: null,
    };
  },
  ...(config.NODE_ENV !== "production"
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        },
      }
    : {}),
});

/**
 * Create a child logger scoped to a specific component.
 * Additional context (requestId, conversationId, traceId, durationMs)
 * can be added at call sites via the log object or further child loggers.
 */
export function createLogger(component: string): pino.Logger {
  return rootLogger.child({ component });
}

export default rootLogger;
