import { pool } from "../adapters/postgres/PostgresAdapter";
import { createLogger } from "../observability/logger";
import { TakeoverManager } from "../human-takeover/TakeoverManager";
import { adminSocketRegistry } from "../api/AdminSocketRegistry";
import { config } from "../config/env";

/**
 * Both of these modules initialise eagerly at import time.
 *
 * `CustomerConfirmationHandler` constructs `new PlaneService(new PostgresAdapter())`
 * in an instance field initialiser (line 75) and then instantiates itself at
 * module scope (line 379), so merely importing it builds a database adapter.
 * `lineWebhook` reaches the same handler. That was harmless while only the LINE
 * route imported them — it loads late — but importing them from here put them
 * on the WebChat gateway's import path, where they run while
 * `PostgresAdapter` is still initialising:
 *
 *   ReferenceError: Cannot access 'PostgresAdapter' before initialization
 *
 * and the entire backend failed to boot. Deferring to call time breaks the
 * cycle without touching either module, which belong to other work in flight.
 */
async function confirmationHandler() {
  const mod = await import("./CustomerConfirmationHandler");
  return mod.customerConfirmationHandler;
}

async function pureSmallTalk(text: string) {
  const mod = await import("../api/routes/lineWebhook");
  return mod.detectPureSmallTalk(text);
}

const logger = createLogger("CustomerMessagePreRouter");

export type WebChatAction = { label: string; value: string; style?: "primary" | "default" };

export const WEBCHAT_ACTIONS: Record<string, WebChatAction> = {
  start: { label: "🚀 เริ่มใช้งาน", value: "start" },
  report_issue: { label: "📝 แจ้งปัญหา", value: "report_issue", style: "primary" },
  check_status: { label: "🔍 ตรวจสอบสถานะ", value: "check_status" },
  close_case: { label: "✅ ปิดเคส", value: "close_case" },
  change_project: { label: "🔄 เปลี่ยนโปรเจกต์", value: "change_project" },
  connect_new: { label: "🔗 เชื่อมใหม่", value: "connect_new" },
};

export function buildWebChatMenu(): { text: string; actions: WebChatAction[] } {
  return {
    text: "สวัสดีค่ะ ยินดีต้อนรับสู่ศูนย์บริการ TicketX ค่ะ! ต้องการให้ช่วยเรื่องไหนดีคะ เลือกจากเมนูด้านล่าง หรือพิมพ์แจ้งเรื่องได้เลยค่ะ",
    actions: [
      WEBCHAT_ACTIONS.start,
      WEBCHAT_ACTIONS.report_issue,
      WEBCHAT_ACTIONS.check_status,
      WEBCHAT_ACTIONS.close_case,
      WEBCHAT_ACTIONS.change_project,
      WEBCHAT_ACTIONS.connect_new,
    ],
  };
}

export interface PreRouterInput {
  channel: "webchat" | "line";
  conversationId: number;
  text: string;
  senderId?: string;
  projectId?: number | null;
  correlationId?: string;
}

export interface PreRouterResult {
  handled: boolean;
  replyText?: string;
  actions?: WebChatAction[];
  takeover?: boolean;
  reason?: string;
  ticketId?: number | null;
}

export class CustomerMessagePreRouter {
  private readonly takeoverManager = new TakeoverManager();

  private async triggerHumanTakeover(conversationId: number, content: string, projectId?: number | null): Promise<void> {
    const convIdStr = String(conversationId);
    const pendingDurationMs = (config.HUMAN_PENDING_TIMEOUT_MINUTES || 15) * 60 * 1000;
    await this.takeoverManager.setTakeoverState(convIdStr, "PENDING_HUMAN", undefined, pendingDurationMs);

    let projId = projectId;
    if (!projId) {
      try {
        const res = await pool.query(`SELECT project_id FROM conversations WHERE id = $1 LIMIT 1`, [conversationId]);
        projId = res.rows[0]?.project_id ? Number(res.rows[0].project_id) : null;
      } catch {}
    }

    if (projId) {
      adminSocketRegistry.broadcastToProject(
        String(projId),
        JSON.stringify({
          event: "NEW_HUMAN_REQUEST",
          data: {
            conversationId: convIdStr,
            customerName: null,
            lastMessage: content || "Customer requested human support",
            reasonCode: "CUSTOMER_REQUESTED_HUMAN",
            reasonDetail: "Customer requested human support via keyword",
            createdAt: new Date().toISOString(),
          },
        })
      );
    }
  }

  /**
   * Evaluates inbound customer text at the edge.
   * If handled, returns a structured reply with action buttons and suppresses the AI flow.
   * If unhandled, returns { handled: false }, letting the message flow to PromptX.
   */
  async route(input: PreRouterInput): Promise<PreRouterResult> {
    const text = String(input.text || "").trim();
    if (!text) {
      return { handled: false };
    }

    // 1. Human Takeover Request keywords
    if (/^(?:ติดต่อเจ้าหน้าที่|คุยกับคน|ขอคุยกับคน|ขอคุยกับเจ้าหน้าที่|ติดต่อคน|human|operator|agent)(?:ค่ะ|คะ|ครับ|งับ|นะ)?$/i.test(text)) {
      logger.info({ conversationId: input.conversationId, text }, "[PreRouter] Intercepted human takeover request keyword");
      try {
        await this.triggerHumanTakeover(input.conversationId, text, input.projectId);
      } catch (takeoverErr: any) {
        logger.warn({ error: takeoverErr.message, conversationId: input.conversationId }, "[PreRouter] Failed requesting human takeover");
      }
      return {
        handled: true,
        takeover: true,
        replyText: "ระบบกำลังประสานงานส่งต่อให้เจ้าหน้าที่เข้ามาดูแลสักครู่นะคะ เจ้าหน้าที่จะตอบกลับท่านผ่านช่องทางนี้โดยตรงค่ะ",
        reason: "HUMAN_TAKEOVER_REQUESTED",
      };
    }

    // 2. Pure Small Talk (Greeting / Thanks)
    const smallTalk = await pureSmallTalk(text);
    if (smallTalk === "greeting") {
      logger.info({ conversationId: input.conversationId, text }, "[PreRouter] Intercepted pure greeting small talk");
      const menu = buildWebChatMenu();
      return {
        handled: true,
        replyText: menu.text,
        actions: menu.actions,
        reason: "SMALL_TALK_GREETING",
      };
    }
    if (smallTalk === "thanks") {
      logger.info({ conversationId: input.conversationId, text }, "[PreRouter] Intercepted pure thanks small talk");
      return {
        handled: true,
        replyText: "ยินดีให้บริการเสมอค่ะ! หากต้องการความช่วยเหลือเพิ่มเติม สามารถพิมพ์สอบถามหรือเลือกเมนูด้านล่างได้ตลอดเวลานะคะ 😊",
        actions: [WEBCHAT_ACTIONS.report_issue, WEBCHAT_ACTIONS.check_status],
        reason: "SMALL_TALK_THANKS",
      };
    }

    // 3. Menu and Static Command Triggers
    if (/^(?:เมนู|\/menu|menu|ขอเมนู|ดูเมนู|แสดงเมนู|show_menu)$/i.test(text)) {
      const menu = buildWebChatMenu();
      return {
        handled: true,
        replyText: menu.text,
        actions: menu.actions,
        reason: "MENU_COMMAND",
      };
    }

    if (/^(?:เริ่มใช้งาน|\/start|start|เริ่มต้น)$/i.test(text)) {
      return {
        handled: true,
        replyText: "👋 ยินดีต้อนรับสู่ TicketX Support ค่ะ! ท่านสามารถสอบถามข้อสงสัย แจ้งปัญหาการใช้งาน หรือติดตามสถานะตั๋วงานได้ตลอดเวลาเลยนะคะ",
        actions: [WEBCHAT_ACTIONS.report_issue, WEBCHAT_ACTIONS.check_status, WEBCHAT_ACTIONS.change_project],
        reason: "START_COMMAND",
      };
    }

    if (/^(?:แจ้งปัญหา|เปิดเคส|เปิดตั๋ว|report_issue)$/i.test(text)) {
      return {
        handled: true,
        replyText: "ได้เลยค่ะ เล่ารายละเอียดปัญหาที่พบให้ฟังได้เลยนะคะ หรือกดปุ่ม '+ เปิดตั๋วใหม่' ด้านบนเพื่อกรอกแบบฟอร์มและแนบรูปภาพค่ะ",
        actions: [WEBCHAT_ACTIONS.check_status],
        reason: "REPORT_ISSUE_COMMAND",
      };
    }

    if (/^(?:เปลี่ยนโปรเจกต์|สลับโปรเจกต์|change_project)$/i.test(text)) {
      return {
        handled: true,
        replyText: "ต้องการสลับโปรเจกต์ใช่ไหมคะ? ท่านสามารถพิมพ์ชื่อโครงการที่ต้องการสลับ หรือกดปุ่ม 'เชื่อมโปรเจกต์ใหม่' ด้านล่างได้เลยค่ะ",
        actions: [WEBCHAT_ACTIONS.connect_new, WEBCHAT_ACTIONS.check_status],
        reason: "CHANGE_PROJECT_COMMAND",
      };
    }

    if (/^(?:เชื่อมใหม่|เชื่อมต่อโปรเจกต์|connect_new)$/i.test(text)) {
      return {
        handled: true,
        replyText: "กรุณาพิมพ์ **รหัสโครงการ (Project Code รูปแบบ TX-XXXX-XXXX)** หรือรหัส 4 หลัก เพื่อยืนยันและเชื่อมต่อเข้าสู่โครงการใหม่ค่ะ",
        reason: "CONNECT_NEW_COMMAND",
      };
    }

    // 4. Customer Confirmation Protocol (Two-Step Close / Confirm / Reopen)
    const isConfirmationCandidate =
      /(?:ใช้งานได้แล้ว|ยังมีปัญหาอยู่|ยืนยันปิดเคส|ยังไม่ปิด|ปิดเคส|ยืนยัน|ยกเลิก)/i.test(text) ||
      text.startsWith("close_case");

    if (isConfirmationCandidate) {
      try {
        const outcome = await (await confirmationHandler()).handle({
          conversationId: input.conversationId,
          correlationId: input.correlationId,
          text,
        });
        if (outcome.handled) {
          logger.info(
            { conversationId: input.conversationId, outcome, text },
            "[PreRouter] Customer confirmation handled at edge"
          );
          return {
            handled: true,
            ticketId: outcome.ticketId,
            reason: outcome.reason,
          };
        }
      } catch (confirmErr: any) {
        logger.error(
          { error: confirmErr.message, conversationId: input.conversationId },
          "[PreRouter] Customer confirmation handler error; allowing AI turn"
        );
      }
    }

    // 5. Explicit Ticket Number Status Lookup (e.g. "TCK-2026-31409")
    const ticketMatch = text.match(/TCK-\d{4}-\d{4,6}/i);
    if (ticketMatch) {
      const ticketNum = ticketMatch[0].toUpperCase();
      const isExplicitStatusQuery =
        text.length <= 40 ||
        /(?:สถานะ|เช็ค|ตรวจสอบ|ติดตาม|เป็นไง|ถึงไหน|ดูเคส|status)/i.test(text);

      if (isExplicitStatusQuery) {
        try {
          const { rows } = await pool.query(
            `SELECT id, ticket_number, subject, status, priority, created_at, resolved_at, updated_at
               FROM tickets
              WHERE UPPER(ticket_number) = $1 AND deleted_at IS NULL
              LIMIT 1`,
            [ticketNum]
          );

          if (rows.length > 0) {
            const t = rows[0];
            const statusMap: Record<string, string> = {
              OPEN: "เปิดเคสแล้ว (รอการตรวจสอบ)",
              IN_PROGRESS: "กำลังดำเนินการแก้ไข",
              RESOLVED: "แก้ไขเรียบร้อยแล้ว (รอการตรวจสอบจากท่าน)",
              CUSTOMER_CONFIRMED: "ลูกค้ายืนยันแล้ว (รอปิดเคส)",
              CLOSED: "ปิดเคสเรียบร้อยแล้ว",
              CANCELLED: "ยกเลิกเคสแล้ว",
            };
            const priorityMap: Record<string, string> = {
              URGENT: "ด่วนที่สุด 🔴",
              HIGH: "สูง 🟠",
              MEDIUM: "ปานกลาง 🟡",
              LOW: "ปกติ 🟢",
            };
            const statusTh = statusMap[String(t.status || "").toUpperCase()] || t.status;
            const priorityTh = priorityMap[String(t.priority || "").toUpperCase()] || t.priority || "ปกติ";

            let replyText = `📌 **สถานะตั๋วงาน ${t.ticket_number}**\n• หัวข้อ: ${t.subject || "-"}\n• สถานะปัจจุบัน: **${statusTh}**\n• ระดับความสำคัญ: ${priorityTh}`;

            const actions: WebChatAction[] = [];
            const st = String(t.status || "").toUpperCase();
            if (st === "RESOLVED" || st === "CUSTOMER_CONFIRMED") {
              replyText += "\n\nหากท่านได้ทดสอบและใช้งานได้เรียบร้อยแล้ว สามารถกด 'ยืนยันปิดเคส' ได้เลยนะคะ";
              actions.push(
                { label: "🟢 ยืนยันปิดเคส", value: `ยืนยันปิดเคส ${t.ticket_number}`, style: "primary" },
                { label: "🔴 ยังมีปัญหาอยู่", value: `ยังมีปัญหาอยู่ ${t.ticket_number}` }
              );
            } else if (st === "CLOSED") {
              actions.push(WEBCHAT_ACTIONS.report_issue, WEBCHAT_ACTIONS.check_status);
            } else {
              actions.push(WEBCHAT_ACTIONS.check_status, WEBCHAT_ACTIONS.report_issue);
            }

            return {
              handled: true,
              replyText,
              actions,
              ticketId: t.id,
              reason: "TICKET_STATUS_LOOKUP",
            };
          } else {
            return {
              handled: true,
              replyText: `ไม่พบตั๋วงานหมายเลข **${ticketNum}** ในระบบค่ะ กรุณาตรวจสอบหมายเลขอีกครั้ง หรือเลือกดูตั๋วทั้งหมดได้ที่เมนู 'ตั๋วของฉัน' นะคะ`,
              actions: [WEBCHAT_ACTIONS.check_status, WEBCHAT_ACTIONS.report_issue],
              reason: "TICKET_NOT_FOUND",
            };
          }
        } catch (dbErr: any) {
          logger.error({ error: dbErr.message, ticketNum }, "[PreRouter] Error looking up ticket status");
        }
      }
    }

    // 6. Active Tickets List Command ("ตรวจสอบสถานะ", "เช็คสถานะ")
    if (/^(?:ตรวจสอบสถานะ|เช็คสถานะ|ติดตามสถานะ|ดูสถานะ|สถานะตั๋ว|check_status)$/i.test(text)) {
      try {
        const { rows } = await pool.query(
          `SELECT id, ticket_number, subject, status
             FROM tickets
            WHERE conversation_id = $1
              AND deleted_at IS NULL
              AND UPPER(COALESCE(status, '')) NOT IN ('CLOSED', 'CANCELLED')
            ORDER BY lifecycle_changed_at DESC NULLS LAST, id DESC
            LIMIT 5`,
          [input.conversationId]
        );

        if (rows.length === 0) {
          return {
            handled: true,
            replyText: "ขณะนี้ท่านยังไม่มีตั๋วงานที่เปิดค้างอยู่ค่ะ สามารถกดปุ่ม '+ เปิดตั๋วใหม่' ด้านบน หรือพิมพ์เล่ารายละเอียดปัญหาเพื่อเปิดเคสใหม่ได้เลยนะคะ",
            actions: [WEBCHAT_ACTIONS.report_issue],
            reason: "NO_ACTIVE_TICKETS",
          };
        }

        let listText = "📋 **รายการตั๋วงานที่กำลังดำเนินการของท่าน:**\n";
        const actions: WebChatAction[] = [];
        for (const t of rows) {
          listText += `\n• **${t.ticket_number}**: ${t.subject || "-"}\n  (สถานะ: ${t.status})`;
          if (t.status === "RESOLVED" || t.status === "CUSTOMER_CONFIRMED") {
            actions.push({ label: `✅ ปิดเคส ${t.ticket_number}`, value: `ยืนยันปิดเคส ${t.ticket_number}` });
          }
        }
        listText += "\n\nท่านสามารถพิมพ์หมายเลขตั๋วงานเพื่อดูรายละเอียด หรือแตะปุ่มด้านล่างได้เลยค่ะ";
        actions.push(WEBCHAT_ACTIONS.report_issue);

        return {
          handled: true,
          replyText: listText,
          actions,
          reason: "ACTIVE_TICKETS_LIST",
        };
      } catch (listErr: any) {
        logger.error({ error: listErr.message, conversationId: input.conversationId }, "[PreRouter] Error listing active tickets");
      }
    }

    // Not handled deterministically -> let the message flow to the AI core flow
    return { handled: false };
  }
}

export const customerMessagePreRouter = new CustomerMessagePreRouter();
