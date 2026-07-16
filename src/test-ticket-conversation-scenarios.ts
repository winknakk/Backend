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
  assert(router.calls[0].toolName === "find_ticket", "create flow should check find_ticket before create_ticket");
  assert(router.lastCall("create_ticket"), "create flow should call create_ticket when no duplicate exists");

  result = await agent.handle(msg("เลขอะไรนะ"), sessionContext);
  assert(result.text.includes("TCK-2026-90001"), "number follow-up should remember the last created ticket");

  result = await agent.handle(msg("ปิดเลย"), sessionContext);
  assert(result.text.includes("TCK-2026-90001"), "close follow-up should resolve the remembered ticket");
  assert(router.lastCall("close_ticket")?.params.ticketId === "TCK-2026-90001", "close should use remembered ticket id");

  router.nextTicketId = "TCK-2026-90002";
  result = await agent.handle(msg("เปิดใหม่ printer ยังพิมพ์ไม่ได้"), sessionContext);
  assert(result.text.includes("TCK-2026-90002"), "open again after close should create a new ticket");

  const duplicateRouter = new ScenarioRouter();
  duplicateRouter.tickets = [
    {
      id: 2,
      ticketId: "TCK-2026-11111",
      subject: "IT support requested: printer พิมพ์ไม่ได้",
      summary: "printer พิมพ์ไม่ได้",
      runningSummary: "printer พิมพ์ไม่ได้",
      status: "open",
    },
  ];
  const duplicateAgent = new TicketAgent(duplicateRouter);
  result = await duplicateAgent.handle(msg("เปิดเรื่อง printer พิมพ์ไม่ได้อีกแล้ว"), sessionContext);
  assert(result.text.includes("อัปเดตใบนี้แทนไหม"), "probable duplicate should ask before creating another ticket");
  assert(!duplicateRouter.lastCall("create_ticket"), "duplicate prompt should not create a ticket yet");

  result = await duplicateAgent.handle(msg("ใช่"), sessionContext);
  assert(result.text.includes("TCK-2026-11111"), "confirmation should update the duplicate ticket");
  assert(duplicateRouter.lastCall("update_summary")?.params.ticketId === "TCK-2026-11111", "confirmation should call update_summary");

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
