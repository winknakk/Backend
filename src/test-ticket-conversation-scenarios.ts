import assert from "assert";
import { randomUUID } from "crypto";
import { TicketAgent } from "./agent/supervisor/TicketAgent";
import { IMcpToolRouter } from "./agent/AgentRuntime";
import { InboundMessage } from "./schemas/validation";

type ToolCall = { toolName: string; params: Record<string, any> };

class ScenarioRouter implements IMcpToolRouter {
  calls: ToolCall[] = [];
  tickets: any[] = [];
  nextTicketId = "TCK-2026-90001";

  async callTool(toolName: string, params: Record<string, any>): Promise<any> {
    this.calls.push({ toolName, params });

    if (toolName === "find_ticket") {
      return { success: true, data: this.tickets, error: null, source: "test", executionId: randomUUID() };
    }

    if (toolName === "create_ticket") {
      const normalizedSubject = String(params.subject || "").trim().replace(/\s+/g, " ").toLowerCase();
      const existing = this.tickets.find(
        (ticket) =>
          !["closed", "done", "cancelled", "canceled", "resolved", "merged"].includes(
            String(ticket.status || "").toLowerCase()
          ) &&
          String(ticket.subject || "").trim().replace(/\s+/g, " ").toLowerCase() === normalizedSubject
      );
      if (existing) {
        return { success: true, data: existing, error: null, source: "test_idempotent", executionId: randomUUID() };
      }

      const ticket = {
        id: this.tickets.length + 1,
        ticketId: this.nextTicketId,
        subject: params.subject,
        summary: params.summary,
        runningSummary: params.summary,
        status: "open",
      };
      this.tickets.unshift(ticket);
      return { success: true, data: ticket, error: null, source: "test", executionId: randomUUID() };
    }

    if (toolName === "get_ticket_status") {
      const ticket = this.tickets.find((t) => t.ticketId === params.ticketId) || { ticketId: params.ticketId, status: "open" };
      return { success: true, data: ticket, error: null, source: "test", executionId: randomUUID() };
    }

    if (toolName === "close_ticket") {
      const ticket = this.tickets.find((t) => t.ticketId === params.ticketId);
      if (ticket) ticket.status = "closed";
      return {
        success: true,
        data: { ticketId: params.ticketId, status: "closed" },
        error: null,
        source: "test",
        executionId: randomUUID(),
      };
    }

    if (toolName === "update_summary") {
      const ticket = this.tickets.find((t) => t.ticketId === params.ticketId);
      if (ticket) {
        ticket.runningSummary = params.runningSummary;
        ticket.lastAiSummary = params.lastAiSummary;
      }
      return {
        success: true,
        data: { ticketId: params.ticketId, updated: true },
        error: null,
        source: "test",
        executionId: randomUUID(),
      };
    }

    if (toolName === "merge_ticket") {
      return {
        success: true,
        data: { ticketId: params.ticketId, merged: true },
        error: null,
        source: "test",
        executionId: randomUUID(),
      };
    }

    return { success: false, data: null, error: `Unexpected tool ${toolName}`, source: "test", executionId: randomUUID() };
  }

  lastCall(toolName: string): ToolCall | undefined {
    return [...this.calls].reverse().find((call) => call.toolName === toolName);
  }
}

const sessionContext = {
  requestId: "test-request",
  conversationId: "42",
  projectId: "1",
  companyId: "1",
  history: [],
};

function msg(text: string): InboundMessage {
  return {
    senderId: "user-1",
    channel: "LINE",
    text,
    receivedAt: new Date().toISOString(),
  };
}

async function run() {
  const router = new ScenarioRouter();
  const agent = new TicketAgent(router);

  let result = await agent.handle(msg("เปิดเรื่อง printer พิมพ์ไม่ได้"), sessionContext);
  assert(result.text.includes("TCK-2026-90001"), "created ticket number should be returned");
  assert(router.calls[0].toolName === "create_ticket", "new incidents should go directly to create_ticket");
  assert(!router.lastCall("find_ticket"), "new incidents should not use fuzzy preflight lookup");

  result = await agent.handle(msg("เลขอะไรนะ"), sessionContext);
  assert(result.text.includes("TCK-2026-90001"), "number follow-up should remember the last created ticket");

  result = await agent.handle(msg("ปิดเลย"), sessionContext);
  assert(result.text.includes("TCK-2026-90001"), "close follow-up should resolve the remembered ticket");
  assert(router.lastCall("close_ticket")?.params.ticketId === "TCK-2026-90001", "close should use remembered ticket id");

  router.nextTicketId = "TCK-2026-90002";
  result = await agent.handle(msg("เปิดใหม่ printer ยังพิมพ์ไม่ได้"), sessionContext);
  assert(result.text.includes("TCK-2026-90002"), "open again after close should create a new ticket");

  const terminalRouter = new ScenarioRouter();
  terminalRouter.nextTicketId = "TCK-2026-90003";
  terminalRouter.tickets = [
    { id: 10, ticketId: "TCK-2026-80001", subject: "405 Method Not Allowed", status: "Done" },
    { id: 11, ticketId: "TCK-2026-80002", subject: "405 Method Not Allowed", status: "Cancelled" },
  ];
  const terminalAgent = new TicketAgent(terminalRouter);
  result = await terminalAgent.handle(
    msg("ระบบล่มขึ้น 405 Method Not Allowed เข้าไม่ได้เลย"),
    { ...sessionContext, history: [{ content: "เรื่องนี้เคยมี TCK-2026-80001 แต่ปิดแล้ว" }] }
  );
  assert(result.text.includes("TCK-2026-90003"), "terminal tickets and stale history must not block a new ticket");
  assert(terminalRouter.lastCall("create_ticket"), "a new incident must create when only terminal tickets exist");

  const distinctRouter = new ScenarioRouter();
  distinctRouter.nextTicketId = "TCK-2026-90004";
  distinctRouter.tickets = [
    {
      id: 2,
      ticketId: "TCK-2026-11111",
      subject: "IT support requested: ระบบล่มขึ้น 405 Method Not Allowed เข้าไม่ได้เลย",
      summary: "ระบบล่มขึ้น 405 Method Not Allowed เข้าไม่ได้เลย",
      runningSummary: "ระบบล่มขึ้น 405 Method Not Allowed เข้าไม่ได้เลย",
      status: "Backlog",
    },
  ];
  const distinctAgent = new TicketAgent(distinctRouter);
  result = await distinctAgent.handle(msg("ระบบล่มขึ้น 444 เข้าไม่ได้เลย ด่วน"), sessionContext);
  assert(result.text.includes("TCK-2026-90004"), "a different error code must create a separate ticket");
  assert(distinctRouter.lastCall("create_ticket"), "a new incident must always go through create_ticket");
  assert(!distinctRouter.lastCall("update_summary"), "a new incident must never be appended through update_summary");

  distinctRouter.nextTicketId = "TCK-2026-90005";
  result = await distinctAgent.handle(msg("อัปเดตหน่อย ระบบล่มขึ้น 500 เข้าไม่ได้เลย"), sessionContext);
  assert(result.text.includes("TCK-2026-90005"), "generic update wording with a new failure must create a separate ticket");
  assert(
    distinctRouter.lastCall("create_ticket")?.params.subject.includes("500"),
    "the newly reported error code must be sent to create_ticket"
  );

  const retryRouter = new ScenarioRouter();
  retryRouter.tickets = [
    {
      id: 3,
      ticketId: "TCK-2026-22221",
      subject: "IT support requested: printer พิมพ์ไม่ได้",
      summary: "printer พิมพ์ไม่ได้",
      status: "Backlog",
    },
  ];
  const retryAgent = new TicketAgent(retryRouter);
  result = await retryAgent.handle(msg("printer พิมพ์ไม่ได้"), sessionContext);
  assert(result.text.includes("TCK-2026-22221"), "an exact active incident retry should remain idempotent");
  assert(retryRouter.lastCall("create_ticket"), "exact retry idempotency should be owned by create_ticket");
  assert(!retryRouter.lastCall("update_summary"), "exact retry must not mutate the existing summary");

  const singleRouter = new ScenarioRouter();
  singleRouter.tickets = [
    { id: 3, ticketId: "TCK-2026-22222", subject: "login failed", summary: "login failed", status: "open" },
  ];
  const singleAgent = new TicketAgent(singleRouter);
  result = await singleAgent.handle(msg("ปิดอันนี้"), sessionContext);
  assert(result.text.includes("TCK-2026-22222"), "single active ticket should be selected automatically");
  assert(singleRouter.lastCall("close_ticket")?.params.ticketId === "TCK-2026-22222", "single active close should call close_ticket");

  const multiRouter = new ScenarioRouter();
  multiRouter.tickets = [
    { id: 4, ticketId: "TCK-2026-33333", subject: "printer jam", summary: "printer paper jam", status: "open" },
    { id: 5, ticketId: "TCK-2026-44444", subject: "login failed", summary: "cannot login sso", status: "open" },
  ];
  const multiAgent = new TicketAgent(multiRouter);
  result = await multiAgent.handle(msg("อัปเดตอันเดิม printer มีกระดาษติด"), sessionContext);
  assert(result.text.includes("TCK-2026-33333"), "multi-ticket update should match by ticket text");
  assert(multiRouter.lastCall("update_summary")?.params.ticketId === "TCK-2026-33333", "matched ticket should be updated");

  result = await multiAgent.handle(msg("รวมสองใบ"), sessionContext);
  assert(multiRouter.lastCall("merge_ticket"), "merge follow-up should merge when exactly two active tickets exist");

  console.log("Ticket conversation scenarios passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
