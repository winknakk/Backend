import { randomUUID } from "crypto";
import { IExecutionTraceService, StartTraceInput } from "./types";
import { AuditLog } from "../schemas/validation";
import { DatabaseAdapter } from "../adapters/types";

export class ExecutionTraceService implements IExecutionTraceService {
  private dbAdapter: DatabaseAdapter;

  constructor(dbAdapter: DatabaseAdapter) {
    this.dbAdapter = dbAdapter;
  }

  async startTrace(input: StartTraceInput): Promise<string> {
    const traceId = randomUUID();
    const newTrace: AuditLog = {
      traceId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      toolName: input.toolName,
      calledAt: new Date().toISOString(),
      reason: input.reason,
      arguments: input.arguments,
      status: "RUNNING",
      requestId: input.requestId,
      conversationId: input.conversationId,
      parentTraceId: input.parentTraceId
    };
    await this.dbAdapter.saveTrace(newTrace);
    return traceId;
  }

  async completeTrace(traceId: string, result: Record<string, any>): Promise<void> {
    const trace = await this.dbAdapter.getTrace(traceId);
    if (trace) {
      trace.result = result;
      trace.status = "COMPLETED";
      trace.completedAt = new Date().toISOString();
      await this.dbAdapter.saveTrace(trace);
    }
  }

  async failTrace(traceId: string, errorMessage: string): Promise<void> {
    const trace = await this.dbAdapter.getTrace(traceId);
    if (trace) {
      trace.errorMessage = errorMessage;
      trace.status = "FAILED";
      trace.completedAt = new Date().toISOString();
      await this.dbAdapter.saveTrace(trace);
    }
  }

  async getTrace(traceId: string): Promise<AuditLog> {
    const trace = await this.dbAdapter.getTrace(traceId);
    if (!trace) {
      throw new Error(`Trace log not found: ${traceId}`);
    }
    return trace;
  }

  async listTracesForSession(sessionId: string): Promise<AuditLog[]> {
    return await this.dbAdapter.listTraces(sessionId);
  }

  async listTraces(): Promise<AuditLog[]> {
    return await this.dbAdapter.listAllTraces();
  }
}
