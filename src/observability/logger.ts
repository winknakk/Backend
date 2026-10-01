import pino from "pino";
import { config } from "../config/env";
import { tracerStore } from "./tracerStore";

const rootLogger = pino({
  level: config.LOG_LEVEL || "info",
  // Credential-bearing fields are censored wherever they appear in a log
  // object (top level or one level down). Free-text secrets are masked at
  // the call sites that forward customer text, via security/secretRedaction.
  redact: {
    paths: [
      "password", "*.password", "newPassword", "*.newPassword",
      "token", "*.token", "accessToken", "*.accessToken", "refreshToken", "*.refreshToken",
      "executionToken", "*.executionToken", "apiKey", "*.apiKey", "api_key", "*.api_key",
      "secret", "*.secret", "authorization", "*.authorization",
      'headers["x-api-key"]', '*.headers["x-api-key"]', "cookie", "*.cookie",
    ],
    censor: "[REDACTED]",
  },
  mixin() {
    const store = tracerStore.getStore();
    return {
      requestId: store?.requestId || null,
      conversationId: store?.conversationId || null,
      traceId: store?.traceId || null,
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
