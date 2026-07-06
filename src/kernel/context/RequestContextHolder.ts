import { AsyncLocalStorage } from "async_hooks";
import { RequestContext } from "./RequestContext";

// Global storage holding the AsyncLocalStorage context
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Executes a callback function scoped inside a specific RequestContext.
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run(context, fn);
}

/**
 * Retrieves the RequestContext for the current execution thread.
 * Throws an error if called outside an active context thread.
 */
export function getRequestContext(): RequestContext {
  const store = requestContextStorage.getStore();
  if (!store) {
    throw new Error("[Kernel] RequestContext is missing in this execution thread context");
  }
  return store;
}

/**
 * Retrieves the RequestContext for the current execution thread or undefined.
 */
export function getOptionalRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * Resolves the active project_id from the context, falling back to '1' for backwards compatibility.
 */
export function getProjectId(): string {
  const store = requestContextStorage.getStore();
  return store?.projectId || "1";
}

/**
 * Resolves the correlationId from the context or returns a default fallback.
 */
export function getCorrelationId(): string {
  const store = requestContextStorage.getStore();
  return store?.correlationId || "corr_fallback";
}
