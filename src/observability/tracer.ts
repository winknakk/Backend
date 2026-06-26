import { randomUUID } from "crypto";
import { tracerStore, TraceContext } from "./tracerStore";
import { createLogger } from "./logger";
import { startTimer } from "./timing";

const logger = createLogger("tracer");

/**
 * Runs a function within the provided trace context.
 */
export function runWithContext<T>(context: TraceContext, fn: () => T | Promise<T>): T | Promise<T> {
  return tracerStore.run(context, fn);
}

/**
 * Executes a function and measures its duration as an OpenTelemetry-compatible span.
 * The span details are outputted to Pino logs.
 */
export async function startSpan<T>(
  name: string,
  fn: () => Promise<T> | T,
  additionalContext: Partial<TraceContext> = {}
): Promise<T> {
  const currentStore = tracerStore.getStore();
  const traceId = additionalContext.traceId || currentStore?.traceId || randomUUID();
  const requestId = additionalContext.requestId || currentStore?.requestId || randomUUID();
  const conversationId = additionalContext.conversationId || currentStore?.conversationId;

  const newContext: TraceContext = {
    traceId,
    requestId,
    conversationId,
    spanName: name,
  };

  const timer = startTimer();

  return runWithContext(newContext, async () => {
    logger.debug({ spanName: name }, `Span started: ${name}`);
    try {
      const result = await fn();
      const durationMs = timer();
      logger.info(
        {
          spanName: name,
          durationMs,
          status: "COMPLETED",
        },
        `Span completed: ${name} in ${durationMs.toFixed(2)}ms`
      );
      return result;
    } catch (err: any) {
      const durationMs = timer();
      logger.error(
        {
          spanName: name,
          durationMs,
          status: "FAILED",
          error: err.message || String(err),
        },
        `Span failed: ${name} in ${durationMs.toFixed(2)}ms`
      );
      throw err;
    }
  }) as Promise<T>;
}
