import { randomUUID } from "crypto";
import { z } from "zod";
import { PolicyEngine } from "./policy/PolicyEngine";
import { McpToolRouter } from "./mcp/McpToolRouter";
import { ToolRegistry } from "./tools/ToolRegistry";
import { IExecutionTraceService, StartTraceInput } from "./execution/types";
import { AuditLog } from "./schemas/validation";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

class InMemoryTraceService implements IExecutionTraceService {
  traces: AuditLog[] = [];

  async startTrace(input: StartTraceInput): Promise<string> {
    const traceId = randomUUID();
    this.traces.push({
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
      parentTraceId: input.parentTraceId,
    });
    return traceId;
  }

  async completeTrace(traceId: string, result: Record<string, any>): Promise<void> {
    const trace = this.traces.find((item) => item.traceId === traceId);
    if (trace) {
      trace.status = "COMPLETED";
      trace.result = result;
      trace.completedAt = new Date().toISOString();
    }
  }

  async failTrace(traceId: string, errorMessage: string): Promise<void> {
    const trace = this.traces.find((item) => item.traceId === traceId);
    if (trace) {
      trace.status = "FAILED";
      trace.errorMessage = errorMessage;
      trace.completedAt = new Date().toISOString();
    }
  }

  async handoffTrace(traceId: string, result: Record<string, any>): Promise<void> {
    const trace = this.traces.find((item) => item.traceId === traceId);
    if (trace) {
      trace.status = "HANDOFF";
      trace.result = result;
      trace.completedAt = new Date().toISOString();
    }
  }

  async getTrace(traceId: string) {
    const trace = this.traces.find((item) => item.traceId === traceId);
    if (!trace) throw new Error("trace not found");
    return trace;
  }

  async listTracesForSession(sessionId: string) {
    return this.traces.filter((item) => item.sessionId === sessionId);
  }

  async listTraces() {
    return this.traces;
  }
}

async function run() {
  const registry = new ToolRegistry();
  registry.registerTool({
    definition: {
      name: "blocked_tool",
      description: "A test tool",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    async execute() {
      return { ok: true };
    },
  });

  const policy = new PolicyEngine(registry, "missing-policy-file.json");
  const traces = new InMemoryTraceService();
  const router = new McpToolRouter(policy, traces, registry);

  const result = await router.callTool(
    "blocked_tool",
    {},
    {
      sessionId: "sess-policy",
      companyId: "tenant-1",
      conversationId: "conv-policy",
      requestId: "req-policy",
      activeAgentId: "knowledge",
    }
  );

  assert(result.success === false, "Expected strict default deny.");
  assert(traces.traces.length === 1, "Expected deny audit trace.");
  assert(traces.traces[0].agentId === "knowledge", "Expected audit trace agentId.");
  assert(traces.traces[0].toolName === "blocked_tool", "Expected audit trace toolName.");
  assert(Boolean(traces.traces[0].reason), "Expected audit trace reason.");

  console.log("test-agent-policy passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
