import { randomUUID } from "crypto";
import { AgentRuntime, IMcpToolRouter } from "./agent/AgentRuntime";
import { IMemoryService } from "./memory/types";
import { IPolicyEngine } from "./policy/types";
import { InboundMessage } from "./schemas/validation";

process.env.NODE_ENV = "test";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

class FakeMemoryService implements IMemoryService {
  logs: Array<{ role: string; message: string }> = [];

  async loadSessionContext() {
    return {
      sessionId: "sess_conv-1",
      companyId: "1",
      conversationId: "conv-1",
      customerRef: "user-1",
      companyContext: {
        companyId: "1",
        companyName: "Test Company",
        status: "Active" as const,
        aiPromptTemplate: "",
        projects: [{ projectId: "p1", projectName: "Support", projectType: "Support" }],
        slaConfig: []
      },
      status: "open" as const,
      handledBy: "ai" as const
    };
  }

  async getConversationHistory() { return []; }
  async appendConversationLog(_conversationId: string, role: "customer" | "ai" | "system", message: string) {
    this.logs.push({ role, message });
  }
  async ensureConversation() { return "conv-1"; }
  async updateHandoffState() {}
}

class FakeMcpRouter implements IMcpToolRouter {
  calls: string[] = [];

  async callTool(toolName: string): Promise<any> {
    this.calls.push(toolName);
    if (toolName === "search_project_docs") {
      return { success: true, data: { results: [] }, error: null, source: "test", executionId: randomUUID() };
    }
    if (toolName === "create_ticket") {
      return { success: true, data: { ticketId: "TCK-TEST-1" }, error: null, source: "test", executionId: randomUUID() };
    }
    throw new Error(`Unexpected tool: ${toolName}`);
  }
}

class FakePolicyEngine implements IPolicyEngine {
  async authorizeToolCall() { return { isAllowed: true, sanitizedParams: {} }; }
  async sanitizeInputText(text: string) { return text; }
  async sanitizeOutputText(text: string) { return text; }
  registerRule() {}
}

async function run() {
  const memory = new FakeMemoryService();
  const router = new FakeMcpRouter();
  const runtime = new AgentRuntime("sess_conv-1", "1", memory, router, new FakePolicyEngine());
  const message: InboundMessage = {
    senderId: "user-1",
    channel: "LINE",
    text: "Cannot login to SSO",
    receivedAt: new Date().toISOString()
  };

  const reply = await runtime.chat(message, "req-handoff");

  assert(router.calls[0] === "search_project_docs", "Expected knowledge search first.");
  assert(router.calls[1] === "create_ticket", "Expected ticket creation after handoff.");
  assert(reply.text.includes("TCK-TEST-1"), "Expected final reply to include ticket id.");
  assert(memory.logs.some((log) => log.role === "system" && log.message.includes("knowledge -> ticket")), "Expected handoff system log.");

  console.log("test-handoff passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
