import { randomUUID } from "node:crypto";
import { traceRecorder, TraceRecorder } from "./TraceRecorder";

/**
 * Safe metadata for one AI generation call, persisted as a `trace_events` row
 * (component "ai"). There is no separate AI telemetry table in the live schema
 * (`ai_inference_logs` exists only in database/latest, and live `traces` has
 * no token or model columns), so the existing causal trace store is reused.
 *
 * Never recorded: prompts, model output, customer text, reasoning, keys.
 * Unknown values are recorded as null. The PromptX `chat` tool reports
 * neither model nor token usage to the backend, so those are null for every
 * PromptX call — a null is honest, an invented count is not.
 */

export type AiOperation = "conversation_summary" | "daily_narrative";

export type AiErrorCategory =
  | "timeout"
  | "circuit_open"
  | "provider_error"
  | "empty_output"
  | "invalid_output"
  | "validation_rejected";

export interface AiTelemetryEvent {
  operation: AiOperation;
  projectId: number;
  conversationId?: number | null;
  provider: string;
  model: string | null;
  modelVersion: string | null;
  promptVersion: string;
  latencyMs: number;
  status: "ok" | "failed";
  errorCategory?: AiErrorCategory | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/** Maps a thrown provider error to a category without keeping its text. */
export function categorizeAiError(err: any): AiErrorCategory {
  const message = String(err?.message || "").toLowerCase();
  if (err?.code === "ECONNABORTED" || message.includes("timeout")) return "timeout";
  if (err?.name === "CircuitBreakerOpenError" || (message.includes("circuit") && message.includes("open"))) return "circuit_open";
  return "provider_error";
}

export async function recordAiTelemetry(event: AiTelemetryEvent, recorder: TraceRecorder = traceRecorder): Promise<void> {
  await recorder.record({
    correlationId: `ai-${randomUUID()}`,
    component: "ai",
    eventType: `ai.${event.operation}`,
    status: event.status,
    projectId: event.projectId,
    conversationId: event.conversationId ?? null,
    detail: {
      operation: event.operation,
      provider: event.provider,
      model: event.model,
      modelVersion: event.modelVersion,
      promptVersion: event.promptVersion,
      latencyMs: Math.round(event.latencyMs),
      errorCategory: event.errorCategory ?? null,
      inputTokens: event.inputTokens ?? null,
      outputTokens: event.outputTokens ?? null,
      tokenUsage: event.inputTokens == null && event.outputTokens == null ? "unavailable" : "measured",
    },
  });
}
