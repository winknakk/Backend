import { AgentResult, IAgent } from "./types";
import { InboundMessage } from "../../schemas/validation";
import { IMcpToolRouter } from "../AgentRuntime";
import { createLogger } from "../../observability/logger";
import { startTimer } from "../../observability/timing";
import { MetricsService } from "../../observability/MetricsService";

const logger = createLogger("TicketAgent");

type TicketIntent = "create" | "status" | "find" | "close" | "merge" | "assign" | "update_summary";

export class TicketAgent implements IAgent {
  readonly id = "ticket";
  readonly name = "Ticket Agent";
  private mcpToolRouter: IMcpToolRouter;

  constructor(mcpToolRouter: IMcpToolRouter) {
    this.mcpToolRouter = mcpToolRouter;
  }

  async handle(message: InboundMessage, sessionContext: any): Promise<AgentResult> {
    MetricsService.getInstance().recordAgentCall("ticket");

    const reqId = sessionContext.requestId;
    const conversationId = sessionContext.conversationId;

    logger.info({ requestId: reqId, conversationId, component: "TicketAgent" }, "Ticket Agent handling message");

    const { getProjectId } = require("../../kernel/context/RequestContextHolder");
    const projectId = getProjectId() || sessionContext.projectId || "1";

    const intent = this.classifyTicketIntent(message.text);

    logger.info(
      { requestId: reqId, conversationId, intent, component: "TicketAgent" },
      `Ticket Agent intent classified: "${intent}"`
    );

    switch (intent) {
      case "status":
        return this.handleStatusCheck(message, sessionContext, projectId);
      case "find":
        return this.handleFindTickets(message, sessionContext, projectId);
      case "close":
        return this.handleCloseTicket(message, sessionContext);
      case "merge":
        return this.handleMergeTicket(message, sessionContext);
      case "assign":
        return this.handleAssignTicket(message, sessionContext);
      case "update_summary":
        return this.handleUpdateSummary(message, sessionContext);
      case "create":
      default:
        return this.handleCreateTicket(message, sessionContext, projectId);
    }
  }

  private classifyTicketIntent(text: string): TicketIntent {
    const lower = text.toLowerCase();

    // Extract ticket ID pattern
    const hasTicketId = /TCK-\d{4}-\d+/i.test(text);

    // Status check
    if (
      lower.includes("สถานะ") ||
      lower.includes("status") ||
      lower.includes("ความคืบหน้า") ||
      lower.includes("ติดตาม") ||
      lower.includes("follow up") ||
      lower.includes("เป็นยังไงบ้าง") ||
      lower.includes("ถึงไหน")
    ) {
      return hasTicketId ? "status" : "find";
    }

    // Find / list tickets
    if (
      lower.includes("ค้นหา") ||
      lower.includes("find") ||
      lower.includes("หาตั๋ว") ||
      lower.includes("เรื่องเดิม") ||
      lower.includes("ตั๋วทั้งหมด") ||
      lower.includes("list")
    ) {
      return "find";
    }

    // Close
    if (
      lower.includes("ปิดตั๋ว") ||
      lower.includes("close ticket") ||
      lower.includes("close") ||
      lower.includes("แก้ไขแล้ว") ||
      lower.includes("resolved")
    ) {
      return "close";
    }

    // Merge
    if (lower.includes("merge") || lower.includes("รวมตั๋ว") || lower.includes("ซ้ำ") || lower.includes("duplicate")) {
      return "merge";
    }

    // Assign
    if (lower.includes("assign") || lower.includes("มอบหมาย") || lower.includes("โอนให้")) {
      return "assign";
    }

    // Update summary
    if (lower.includes("update_summary") || lower.includes("อัปเดตสรุป")) {
      return "update_summary";
    }

    return "create";
  }

  private extractTicketId(text: string): string | null {
    const match = text.match(/TCK-\d{4}-\d+/i);
    return match ? match[0] : null;
  }

  private async handleCreateTicket(
    message: InboundMessage,
    sessionContext: any,
    projectId: string
  ): Promise<AgentResult> {
    const conversationId = sessionContext.conversationId;

    const timer = startTimer();
    const ticketResult = await this.mcpToolRouter.callTool(
      "create_ticket",
      {
        conversationId,
        subject: `IT support requested: ${message.text.slice(0, 50)}...`,
        summary: `User reported issue: "${message.text}" on channel ${message.channel}`,
        priority: "P3",
        severity: "Medium",
        projectId: String(projectId),
      },
      sessionContext
    );

    logger.info(
      {
        requestId: sessionContext.requestId,
        conversationId,
        durationMs: timer(),
        component: "TicketAgent",
        success: ticketResult.success,
      },
      "Ticket Agent ticket creation completed"
    );

    if (!ticketResult.success) {
      return {
        text: `ขออภัยค่ะ/ครับ ไม่สามารถสร้างตั๋วใบงานได้ในขณะนี้: ${ticketResult.error}`,
      };
    }

    const ticket = ticketResult.data;
    return {
      text: `สร้างตั๋วใบงานเรียบร้อยแล้วค่ะ/ครับ หมายเลขตั๋ว: ${ticket.ticketId} ทีมซัพพอร์ตจะติดต่อกลับโดยเร็วที่สุดค่ะ/ครับ`,
    };
  }

  private async handleStatusCheck(
    message: InboundMessage,
    sessionContext: any,
    projectId: string
  ): Promise<AgentResult> {
    const ticketId = this.extractTicketId(message.text);

    if (!ticketId) {
      // No specific ticket ID — find all open tickets for this conversation
      return this.handleFindTickets(message, sessionContext, projectId);
    }

    const timer = startTimer();
    const result = await this.mcpToolRouter.callTool(
      "get_ticket_status",
      { ticketId },
      sessionContext
    );

    logger.info(
      {
        requestId: sessionContext.requestId,
        conversationId: sessionContext.conversationId,
        durationMs: timer(),
        component: "TicketAgent",
        ticketId,
      },
      "Ticket status check completed"
    );

    if (!result.success) {
      return { text: `ขออภัยค่ะ/ครับ ไม่พบข้อมูลตั๋วหมายเลข ${ticketId}` };
    }

    const t = result.data;
    return {
      text: `ข้อมูลตั๋ว ${ticketId}:\n- สถานะ: ${t.status || "ไม่ทราบ"}\n- หัวข้อ: ${t.subject || "-"}\n- ระดับความสำคัญ: ${t.priority || "-"}`,
    };
  }

  private async handleFindTickets(
    message: InboundMessage,
    sessionContext: any,
    projectId: string
  ): Promise<AgentResult> {
    const timer = startTimer();
    const result = await this.mcpToolRouter.callTool(
      "find_ticket",
      {
        conversationId: sessionContext.conversationId,
        projectId: String(projectId),
        query: message.text,
      },
      sessionContext
    );

    logger.info(
      {
        requestId: sessionContext.requestId,
        conversationId: sessionContext.conversationId,
        durationMs: timer(),
        component: "TicketAgent",
      },
      "Ticket search completed"
    );

    if (!result.success || !result.data) {
      return { text: "ไม่พบตั๋วใบงานที่ตรงกับคำค้นหาค่ะ/ครับ" };
    }

    const tickets = Array.isArray(result.data) ? result.data : (result.data.tickets || [result.data]);
    if (tickets.length === 0) {
      return { text: "ไม่พบตั๋วใบงานที่เปิดอยู่ในระบบค่ะ/ครับ" };
    }

    if (tickets.length === 1) {
      const t = tickets[0];
      return {
        text: `พบตั๋ว 1 ใบค่ะ/ครับ:\n- ${t.ticketId || t.ticket_id}: ${t.subject} (สถานะ: ${t.status})`,
      };
    }

    // Multi-ticket disambiguation
    const ticketList = tickets
      .slice(0, 5)
      .map((t: any, i: number) => `${i + 1}. ${t.ticketId || t.ticket_id}: ${t.subject} (${t.status})`)
      .join("\n");

    return {
      text: `พบตั๋วที่เกี่ยวข้อง ${tickets.length} ใบค่ะ/ครับ กรุณาระบุหมายเลขตั๋วที่ต้องการ:\n${ticketList}`,
    };
  }

  private async handleCloseTicket(
    message: InboundMessage,
    sessionContext: any
  ): Promise<AgentResult> {
    const ticketId = this.extractTicketId(message.text);
    if (!ticketId) {
      return { text: "กรุณาระบุหมายเลขตั๋วที่ต้องการปิดด้วยค่ะ/ครับ เช่น TCK-2026-12345" };
    }

    const result = await this.mcpToolRouter.callTool("close_ticket", { ticketId }, sessionContext);
    if (!result.success) {
      return { text: `ขออภัยค่ะ/ครับ ไม่สามารถปิดตั๋ว ${ticketId} ได้: ${result.error}` };
    }

    return { text: `ปิดตั๋ว ${ticketId} เรียบร้อยแล้วค่ะ/ครับ ขอบคุณที่ใช้บริการ` };
  }

  private async handleMergeTicket(
    message: InboundMessage,
    sessionContext: any
  ): Promise<AgentResult> {
    const ticketIds = message.text.match(/TCK-\d{4}-\d+/gi);
    if (!ticketIds || ticketIds.length < 2) {
      return {
        text: "กรุณาระบุหมายเลขตั๋ว 2 ใบที่ต้องการรวมด้วยค่ะ/ครับ เช่น 'รวม TCK-2026-11111 กับ TCK-2026-22222'",
      };
    }

    const result = await this.mcpToolRouter.callTool(
      "merge_ticket",
      { primaryTicketId: ticketIds[0], secondaryTicketId: ticketIds[1] },
      sessionContext
    );

    if (!result.success) {
      return { text: `ขออภัยค่ะ/ครับ ไม่สามารถรวมตั๋วได้: ${result.error}` };
    }

    return { text: `รวมตั๋ว ${ticketIds[1]} เข้ากับตั๋วหลัก ${ticketIds[0]} เรียบร้อยแล้วค่ะ/ครับ` };
  }

  private async handleAssignTicket(
    message: InboundMessage,
    sessionContext: any
  ): Promise<AgentResult> {
    const ticketId = this.extractTicketId(message.text);
    if (!ticketId) {
      return { text: "กรุณาระบุหมายเลขตั๋วที่ต้องการมอบหมายด้วยค่ะ/ครับ" };
    }

    // Extract assignee from message (simple heuristic)
    const assigneeMatch = message.text.match(/(?:ให้|to)\s+([^\s,]+)/i);
    const assignee = assigneeMatch ? assigneeMatch[1] : "pm";

    const result = await this.mcpToolRouter.callTool(
      "assign_ticket",
      { ticketId, assignee },
      sessionContext
    );

    if (!result.success) {
      return { text: `ขออภัยค่ะ/ครับ ไม่สามารถมอบหมายตั๋ว ${ticketId} ได้: ${result.error}` };
    }

    return { text: `มอบหมายตั๋ว ${ticketId} ให้ ${assignee} เรียบร้อยแล้วค่ะ/ครับ` };
  }

  private async handleUpdateSummary(
    message: InboundMessage,
    sessionContext: any
  ): Promise<AgentResult> {
    const ticketId = this.extractTicketId(message.text);
    if (!ticketId) {
      return { text: "กรุณาระบุหมายเลขตั๋วที่ต้องการอัปเดตสรุปด้วยค่ะ/ครับ" };
    }

    const result = await this.mcpToolRouter.callTool(
      "update_summary",
      { ticketId, summary: message.text },
      sessionContext
    );

    if (!result.success) {
      return { text: `ขออภัยค่ะ/ครับ ไม่สามารถอัปเดตสรุปตั๋ว ${ticketId} ได้: ${result.error}` };
    }

    return { text: `อัปเดตสรุปตั๋ว ${ticketId} เรียบร้อยแล้วค่ะ/ครับ` };
  }
}
