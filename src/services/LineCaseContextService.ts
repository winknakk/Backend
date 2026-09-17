import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";
import { caseResolver, type CaseCandidate, type CaseResolutionResult, type CaseResolutionType } from "../domain/case/CaseResolver";
import { customerNotificationService, type NotificationQuickReply } from "./CustomerNotificationService";
import { conversationFocusService } from "./ConversationFocusService";

const logger = createLogger("line-case-context");

/**
 * What the AI gate is told about the case this turn is about. Carried out of
 * band in `payload.ticketx.caseContext`, forwarded by Channel Gateway - LINE
 * as `case_intent` / `case_ticket_number` / `case_force_new`, and consumed by
 * Main AI Core `step_parse_gate`. It is a hint: the gate still extracts the
 * subject / summary / priority itself (spec v2 §1.2 row 6 — the resolver
 * never bypasses the Gatekeeper).
 */
export interface CaseContextHint {
  intent: CaseResolutionType;
  ticketId: number | null;
  ticketNumber: string | null;
  /** True when the resolver decided this is a problem unrelated to any open case (P0 / P7). */
  forceNew: boolean;
  confidence: number;
  reason: string;
}

export interface LineCaseTurnInput {
  conversationId: number;
  projectId?: number | null;
  text: string;
  correlationId?: string;
  /** LINE message id — the persisted inbound row is stamped with the resolved case. */
  externalMessageId?: string;
}

export interface LineCaseTurnResult {
  /** True when the resolver answered the customer itself; the AI turn is skipped. */
  handled: boolean;
  hint: CaseContextHint | null;
  resolution?: CaseResolutionResult;
  reason?: string;
}

/** LINE quick-reply labels are limited to 20 characters and 13 items. */
const LINE_LABEL_MAX = 20;
const LINE_CHIP_MAX = 13;

/** Pure: the hint the gate receives for a resolver decision. */
export function buildCaseHint(res: CaseResolutionResult, openCaseCount: number): CaseContextHint {
  const intent = res.type;
  return {
    intent,
    ticketId: intent === "CONTINUE_ACTIVE_CASE" || intent === "SWITCH_EXISTING_CASE" ? res.ticketId ?? null : null,
    ticketNumber: intent === "CONTINUE_ACTIVE_CASE" || intent === "SWITCH_EXISTING_CASE" ? (res.ticketNumber ? String(res.ticketNumber).toUpperCase() : null) : null,
    // force_new only matters to the hub's duplicate fold, which only exists
    // when there is an open case to fold into.
    forceNew: intent === "NEW_CASE" && openCaseCount > 0,
    confidence: res.confidence,
    reason: res.reason,
  };
}

/** Pure: chips for the "which case?" question — one per candidate plus "new case". */
export function ambiguityChips(candidates: CaseCandidate[]): NotificationQuickReply[] {
  const chips: NotificationQuickReply[] = candidates
    .filter((c) => c.ticket_number)
    .slice(0, LINE_CHIP_MAX - 1)
    .map((c) => ({ label: String(c.ticket_number).slice(0, LINE_LABEL_MAX), text: `สลับไปที่ ${c.ticket_number}` }));
  chips.push({ label: "แจ้งเรื่องใหม่", text: "เปิดเคสใหม่" });
  return chips;
}

/**
 * Pure: chips under the closed-case protection message. "เปิดเคสใหม่" starts
 * a fresh intake; within the re-open window the "ยังมีปัญหาอยู่ <TCK>" chip
 * routes to the Flow 4 protocol in CustomerConfirmationHandler instead.
 */
export function closedReferenceChips(ticketNumber: string | null, closedAt: Date | string | null | undefined, reopenDays: number): NotificationQuickReply[] {
  const chips: NotificationQuickReply[] = [{ label: "เปิดเคสใหม่จากเรื่องนี้", text: "เปิดเคสใหม่" }];
  const closed = closedAt ? new Date(closedAt) : null;
  const withinWindow = Boolean(ticketNumber && closed && !isNaN(closed.getTime()) && reopenDays > 0 && Date.now() - closed.getTime() <= reopenDays * 86_400_000);
  if (withinWindow) chips.push({ label: "ยังมีปัญหาอยู่", text: `ยังมีปัญหาอยู่ ${ticketNumber}` });
  return chips;
}

/**
 * Pure: a message that is ONLY a switch command ("สลับไปที่ TCK-…", "ตามเรื่อง
 * TCK-… ครับ") is answered at the edge; one that carries content ("TCK-… ส่งรูป
 * เพิ่มครับ หน้าจอขึ้น 500") is forwarded to the AI with the hint.
 */
export function isPureSwitchCommand(text: string): boolean {
  const residual = String(text || "")
    .replace(/TCK-\d{4}-\d{4,6}/gi, " ")
    .replace(/สลับไปที่|สลับไป|สลับ|เปลี่ยนไป|กลับไป(?:ที่|ดู)?|ตามเรื่อง|เรื่อง|เคส|ticket|case|switch\s*to|ขอ|ดู|หน่อย|ครับ|ค่ะ|คับ|นะคะ|นะครับ|จ้า|#|\d+/gi, " ")
    .replace(/[\s.,!]+/g, "")
    .trim();
  return residual.length < 4;
}

interface ConversationRow {
  id: number;
  project_id: number | null;
  identity_id: number | null;
  active_ticket_id: number | null;
}

/**
 * Flow 6 on LINE (operator decision 2026-09-17): "which case is this message
 * about?" is decided at the edge with the same CaseResolver the WebChat
 * gateway uses. RESOLVE FIRST → AUTHORIZE SECOND (cases are loaded scoped
 * to the conversation's identity AND project, never by customer text) →
 * UPDATE CONTEXT THIRD (`conversations.active_ticket_id`) → ROUTE FOURTH
 * (the hint travels with the events to the AI gate) → ASK ONLY IF AMBIGUOUS
 * (chips, no AI turn). `conversations.project_id` is never written here.
 */
export class LineCaseContextService {
  async resolveTurn(input: LineCaseTurnInput): Promise<LineCaseTurnResult> {
    const text = String(input.text || "").trim();
    if (!text) return { handled: false, hint: null, reason: "EMPTY_TEXT" };
    try {
      const convRes = await pool.query<ConversationRow>(
        `SELECT id, project_id, identity_id, active_ticket_id FROM conversations WHERE id = $1::integer AND deleted_at IS NULL LIMIT 1`,
        [input.conversationId]
      );
      const conv = convRes.rows[0];
      if (!conv || !conv.project_id || !conv.identity_id) return { handled: false, hint: null, reason: "NO_PROJECT_CONTEXT" };
      if (input.projectId && Number(input.projectId) !== Number(conv.project_id)) {
        // Fail closed on the tenant boundary: the caller's idea of the project
        // and the conversation's do not agree — resolve nothing.
        logger.warn({ conversationId: conv.id, callerProject: input.projectId, convProject: conv.project_id }, "Project mismatch; case context skipped");
        return { handled: false, hint: null, reason: "PROJECT_MISMATCH" };
      }

      const casesRes = await pool.query<CaseCandidate & { closed_at: Date | null }>(
        `SELECT t.id, t.ticket_number, t.ticket_id, t.subject, t.title, t.summary,
                t.running_summary, t.original_problem_statement, t.searchable_text,
                t.issue_category, t.status, t.created_at, t.closed_at
           FROM tickets t
           JOIN conversations c ON c.id = t.conversation_id
          WHERE t.project_id = $1::integer
            AND c.identity_id = $2::integer
            AND t.deleted_at IS NULL
          ORDER BY t.created_at ASC, t.id ASC`,
        [conv.project_id, conv.identity_id]
      );
      const openCases: CaseCandidate[] = [];
      const closedCases: Array<CaseCandidate & { closed_at: Date | null }> = [];
      for (const row of casesRes.rows) {
        const st = String(row.status || "").toUpperCase();
        if (st === "CLOSED" || st === "CANCELLED") closedCases.push(row);
        else openCases.push(row);
      }
      if (openCases.length === 0 && closedCases.length === 0) return { handled: false, hint: null, reason: "NO_CASES" };

      const recentRes = await pool.query<{ id: number; role: string; content: string; ticket_id: number | null }>(
        `SELECT id, role, content, ticket_id FROM messages WHERE conversation_id = $1::integer ORDER BY id DESC LIMIT 15`,
        [conv.id]
      );
      const recentMessages = recentRes.rows.reverse();

      const res = caseResolver.resolve({
        conversationId: conv.id,
        activeTicketId: conv.active_ticket_id ?? null,
        messageText: text,
        openCases,
        closedCases,
        recentMessages,
      });
      const hint = buildCaseHint(res, openCases.length);
      const notifyBase = { conversationId: conv.id, projectId: conv.project_id, correlationId: input.correlationId, idempotencyKey: `${input.correlationId || `conv:${conv.id}:${Date.now()}`}:case_context` };

      if (res.type === "CONTINUE_ACTIVE_CASE" && res.ticketId) {
        if (Number(conv.active_ticket_id || 0) !== Number(res.ticketId)) {
          // P4 (recent context) or the single-open-case default: adopt it as focus.
          await conversationFocusService.setActiveTicket(conv.id, res.ticketId);
        }
        await this.stampMessage(conv.id, input.externalMessageId, res.ticketId);
        return { handled: false, hint, resolution: res, reason: res.reason };
      }

      if (res.type === "SWITCH_EXISTING_CASE" && res.ticketId) {
        const target = openCases.find((c) => Number(c.id) === Number(res.ticketId));
        if (!target) return { handled: false, hint: null, resolution: res, reason: "SWITCH_TARGET_NOT_AUTHORISED" };
        await conversationFocusService.setActiveTicket(conv.id, target.id);
        await this.stampMessage(conv.id, input.externalMessageId, target.id);
        if (isPureSwitchCommand(text)) {
          const subject = String(target.subject || target.title || "").replace(/\s+/g, " ").trim();
          const about = subject ? ` เรื่อง "${subject.length > 80 ? `${subject.slice(0, 80)}…` : subject}"` : "";
          await customerNotificationService.send({
            ...notifyBase,
            notificationType: "case_context",
            ticketId: target.id,
            ticketNumber: target.ticket_number,
            detail: `สลับมาที่เคส ${target.ticket_number}${about} ให้เรียบร้อยแล้วค่ะ มีข้อมูลเพิ่มเติมหรืออยากถามอะไรเกี่ยวกับเคสนี้ แจ้งได้เลยนะคะ`,
            quickReplies: [],
          });
          return { handled: true, hint, resolution: res, reason: "SWITCHED" };
        }
        return { handled: false, hint, resolution: res, reason: res.reason };
      }

      if (res.type === "CLOSED_CASE_REFERENCE") {
        const referenced = closedCases.find((c) => Number(c.id) === Number(res.referencedTicketId));
        if (referenced) {
          await pool
            .query(
              `INSERT INTO ticket_events (ticket_id, event_type, actor, source, correlation_id, payload, created_at)
               VALUES ($1, 'CLOSED_CASE_REFERENCED', 'customer', 'line_case_resolver', $2, $3, NOW())`,
              [referenced.id, input.correlationId || null, JSON.stringify({ conversation_id: conv.id, message_text: text.slice(0, 2000), intent: "CLOSED_CASE_REFERENCE" })]
            )
            .catch((err) => logger.warn({ ticketId: referenced.id, error: err.message }, "Could not record CLOSED_CASE_REFERENCED"));
          // Hard invariant: the message is never attached to the closed case
          // (`messages.ticket_id` stays NULL); the reference lives in reactions.
          await this.markReference(conv.id, input.externalMessageId, referenced.id);
        }
        await customerNotificationService.send({
          ...notifyBase,
          notificationType: "case_context",
          ticketId: null,
          ticketNumber: referenced?.ticket_number ?? res.ticketNumber ?? null,
          detail: res.clarificationPrompt || "เคสที่อ้างถึงปิดเรียบร้อยแล้วค่ะ หากยังต้องการความช่วยเหลือ เปิดเคสใหม่ได้เลยนะคะ",
          quickReplies: closedReferenceChips(referenced?.ticket_number ?? null, referenced?.closed_at ?? null, config.REOPEN_AFTER_CLOSE_DAYS),
        });
        return { handled: true, hint, resolution: res, reason: "CLOSED_CASE_PROTECTED" };
      }

      if (res.type === "AMBIGUOUS_CASE") {
        // Fail-safe: ask, never guess, and leave the focus as it was.
        await customerNotificationService.send({
          ...notifyBase,
          notificationType: "case_context",
          ticketId: null,
          ticketNumber: null,
          detail: res.clarificationPrompt || "ตอนนี้มีหลายเคสที่กำลังดำเนินการอยู่ค่ะ ต้องการแจ้งเรื่องไหนคะ",
          quickReplies: ambiguityChips(res.candidatesDetails || openCases),
        });
        return { handled: true, hint, resolution: res, reason: "AMBIGUOUS_ASKED" };
      }

      // NEW_CASE: intake stays with the AI gate (two-step confirmation); the
      // hint tells the hub not to fold this report into an open case.
      return { handled: false, hint, resolution: res, reason: res.reason };
    } catch (err: any) {
      logger.error({ error: err.message, conversationId: input.conversationId }, "Case context resolution failed; turn continues without a hint");
      return { handled: false, hint: null, reason: "ERROR" };
    }
  }

  /** Attaches the persisted inbound row to the resolved case (never a closed one). */
  private async stampMessage(conversationId: number, externalMessageId: string | undefined, ticketId: number): Promise<void> {
    if (!externalMessageId) return;
    await pool
      .query(
        `UPDATE messages SET ticket_id = $3::integer
          WHERE conversation_id = $1::integer AND external_id = $2 AND ticket_id IS NULL`,
        [conversationId, externalMessageId, ticketId]
      )
      .catch((err) => logger.warn({ conversationId, externalMessageId, error: err.message }, "Could not stamp message with case"));
  }

  private async markReference(conversationId: number, externalMessageId: string | undefined, referencedTicketId: number): Promise<void> {
    if (!externalMessageId) return;
    await pool
      .query(
        `UPDATE messages
            SET reactions = COALESCE(reactions, '{}'::jsonb) || $3::jsonb
          WHERE conversation_id = $1::integer AND external_id = $2`,
        [conversationId, externalMessageId, JSON.stringify({ referenced_ticket_id: referencedTicketId, intent: "CLOSED_CASE_REFERENCE" })]
      )
      .catch((err) => logger.warn({ conversationId, externalMessageId, error: err.message }, "Could not record closed-case reference on message"));
  }
}

export const lineCaseContextService = new LineCaseContextService();
