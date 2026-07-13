import { AsyncLocalStorage } from "async_hooks";
import { RequestContext } from "./RequestContext";

/**
 * Global storage wrapper encapsulating Node's AsyncLocalStorage context.
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * RequestContextHolder exposes static methods to run callbacks in context scopes
 * and safely retrieve request attributes.
 */
export class RequestContextHolder {
  /**
   * Executes a callback function scoped inside a specific RequestContext.
   *
   * @param context - The execution context properties.
   * @param fn - The callback function to run.
   * @returns The returned value from the callback function.
   */
  public static run<T>(context: RequestContext, fn: () => T): T {
    return requestContextStorage.run(context, fn);
  }

  /**
   * Retrieves the RequestContext for the current execution thread.
   * Throws an error if called outside an active context thread.
   *
   * @returns The active RequestContext.
   */
  public static getRequestContext(): RequestContext {
    const store = requestContextStorage.getStore();
    if (!store) {
      throw new Error("[Kernel] RequestContext is missing in this execution thread context");
    }
    return store;
  }

  /**
   * Retrieves the RequestContext for the current execution thread or undefined if not set.
   *
   * @returns The active RequestContext or undefined.
   */
  public static getOptionalRequestContext(): RequestContext | undefined {
    return requestContextStorage.getStore();
  }

  /**
   * Resolves the active project ID from the context, falling back to '1' for backwards compatibility.
   *
   * @returns The active project ID.
   */
  public static getProjectId(): string {
    const store = requestContextStorage.getStore();
    return store?.projectId || "1";
  }

  /**
   * Resolves the correlation ID from the context or returns a default fallback.
   *
   * @returns The correlation ID.
   */
  public static getCorrelationId(): string {
    const store = requestContextStorage.getStore();
    return store?.correlationId || "corr_fallback";
  }
}

/**
 * Executes a callback function scoped inside a specific RequestContext.
 * (Backward compatibility standalone function wrapper)
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return RequestContextHolder.run(context, fn);
}

/**
 * Retrieves the RequestContext for the current execution thread.
 * (Backward compatibility standalone function wrapper)
 */
export function getRequestContext(): RequestContext {
  return RequestContextHolder.getRequestContext();
}

/**
 * Retrieves the RequestContext for the current execution thread or undefined if not set.
 * (Backward compatibility standalone function wrapper)
 */
export function getOptionalRequestContext(): RequestContext | undefined {
  return RequestContextHolder.getOptionalRequestContext();
}

/**
 * Resolves the active project ID from the context.
 * (Backward compatibility standalone function wrapper)
 */
export function getProjectId(): string {
  return RequestContextHolder.getProjectId();
}

/**
 * Resolves the correlation ID from the context.
 * (Backward compatibility standalone function wrapper)
 */
export function getCorrelationId(): string {
  return RequestContextHolder.getCorrelationId();
}
