import { AsyncLocalStorage } from "async_hooks";

export interface TraceContext {
  traceId: string;
  requestId: string;
  conversationId?: string;
  spanName?: string;
}

export const tracerStore = new AsyncLocalStorage<TraceContext>();
