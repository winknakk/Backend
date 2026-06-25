import { z } from "zod";
import { AuditLog } from "../schemas/validation";

export const StartTraceInputSchema = z.object({
  sessionId: z.string(),
  agentId: z.string().optional(),
  toolName: z.string(),
  reason: z.string().optional(), // Why the Agent called this tool
  arguments: z.record(z.any()),
  requestId: z.string().optional(),
  conversationId: z.string().optional(),
  parentTraceId: z.string().optional(),
});
export type StartTraceInput = z.infer<typeof StartTraceInputSchema>;

export interface IExecutionTraceService {
  /**
   * Initializes a new execution trace for a tool call, returning the trace UUID.
   * Logs that the tool has started executing.
   */
  startTrace(input: StartTraceInput): Promise<string>;

  /**
   * Finalizes the trace, recording the successful tool return output and updating status to COMPLETED.
   */
  completeTrace(traceId: string, result: Record<string, any>): Promise<void>;

  /**
   * Logs a failed tool execution, saving the error message and updating status to FAILED.
   */
  failTrace(traceId: string, errorMessage: string): Promise<void>;

  /**
   * Retrieves a single trace details by UUID.
   */
  getTrace(traceId: string): Promise<AuditLog>;

  /**
   * Lists all execution logs and tool call histories for a specific conversation session.
   * Useful for LLM debugging and admin auditing.
   */
  listTracesForSession(sessionId: string): Promise<AuditLog[]>;

  /**
   * Lists all execution traces globally.
   */
  listTraces(): Promise<AuditLog[]>;
}
