/**
 * CaseFollowUpService — "เปิดเคสใหม่จากเรื่องนี้" (2026-09-18).
 *
 * When the customer taps the chip under the closed-case protection (or types a
 * bare "เปิดเคสใหม่"), LINE used to forward the chip text to the AI gate, which
 * filed it verbatim as the subject ("เรื่อง: เปิดเคสใหม่", TCK-2026-81490). Now:
 *
 *   1. the edge answers the tap itself (ask for the report; no AI turn),
 *   2. the closed case is remembered as a FOLLOW_UP_REQUESTED ticket event,
 *   3. the next report becomes the new case (hint NEW_CASE / force_new),
 *   4. at promotion the new case inherits `parent_ticket_id` when the gate did
 *      not set it, the Plane work item gets a "Related case" row + a
 *      "Follow-up of a closed case" section with a link, and the OLD work item
 *      gets a comment pointing at the new one.
 *
 * Pure helpers are exported for tests; only the class touches the database.
 */
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";

const logger = createLogger("case-follow-up");

/** The chip text on LINE / WebChat, or a bare "เปิดเคสใหม่". Nothing else. */
export const NEW_CASE_COMMAND = /^\s*(?:เปิดเคสใหม่|แจ้งเรื่องใหม่|เปิดตั๋วใหม่)(?:\s*[:：]\s*ติดตามต่อจาก\s*(TCK-\d{4}-\d{4,6}))?\s*$/i;

/** Pure: null when the text is not a bare new-case command. */
export function parseNewCaseCommand(text: string): { ticketNumber: string | null } | null {
  const m = String(text || "").match(NEW_CASE_COMMAND);
  if (!m) return null;
  return { ticketNumber: m[1] ? m[1].toUpperCase() : null };
}

export interface RelatedCaseInfo {
  ticketId: number;
  ticketNumber: string;
  subject: string | null;
  status: string | null;
  closedAt: Date | null;
  /** Plane's human identifier, e.g. "EXAI-98", when it could be fetched. */
  sequenceLabel: string | null;
  planeIssueId: string | null;
  url: string | null;
}

/** Pure: browser link to a work item, or null when any part is unknown. */
export function planeWorkItemWebUrl(workspaceSlug: string | null | undefined, projectId: string | null | undefined, issueId: string | null | undefined): string | null {
  if (!workspaceSlug || !projectId || !issueId) return null;
  const base = String(config.PLANE_WEB_URL || "").replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}`;
}

/** Pure: "TCK-2026-86186 (EXAI-98)" or just the number. */
export function relatedCaseLabel(r: Pick<RelatedCaseInfo, "ticketNumber" | "sequenceLabel">): string {
  return r.sequenceLabel ? `${r.ticketNumber} (${r.sequenceLabel})` : r.ticketNumber;
}

/** dd/mm/yyyy HH:mm in Asia/Bangkok for engineers (Christian year, unlike the customer cards). */
export function bangkokDateTime(value: Date | string | null | undefined): string {
  const d = value instanceof Date ? value : new Date(String(value || ""));
  if (!value || isNaN(d.getTime())) return "";
  const b = new Date(d.getTime() + 7 * 3_600_000);
  const pad = (x: number) => (x < 10 ? `0${x}` : String(x));
  return `${pad(b.getUTCDate())}/${pad(b.getUTCMonth() + 1)}/${b.getUTCFullYear()} ${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}`;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Pure: value of the "Related case" metadata row (plain text; the caller escapes). */
export function relatedCaseMetadataValue(r: RelatedCaseInfo): string {
  const closed = bangkokDateTime(r.closedAt);
  const state = String(r.status || "").toUpperCase() === "CANCELLED" ? "ยกเลิกเมื่อ" : "ปิดเมื่อ";
  return closed ? `${relatedCaseLabel(r)} · ${state} ${closed}` : relatedCaseLabel(r);
}

/** Pure: the section under the customer report on the NEW work item. */
export function relatedCaseSectionHtml(r: RelatedCaseInfo): string {
  const closed = bangkokDateTime(r.closedAt);
  const verb = String(r.status || "").toUpperCase() === "CANCELLED" ? "ถูกยกเลิกไปเมื่อ" : "ปิดไปเมื่อ";
  const lines = [
    `ลูกค้าเปิดเคสนี้ต่อจาก <strong>${esc(relatedCaseLabel(r))}</strong>${closed ? ` ซึ่ง${verb} ${esc(closed)}` : ""}`,
    r.subject ? `เรื่องเดิม: ${esc(r.subject)}` : "",
    r.url ? `<a href="${esc(r.url)}">เปิดเคสเดิมใน Plane</a>` : "",
  ].filter(Boolean);
  return `<h3>🔗 Follow-up of a closed case</h3><p>${lines.join("<br>")}</p>`;
}

/** Pure: the comment left on the OLD work item. */
export function followUpCommentHtml(child: { ticketNumber: string; sequenceLabel: string | null; subject: string | null; url: string | null }): string {
  const lines = [
    `🔗 ลูกค้าเปิดเคสใหม่ต่อจากเคสนี้: <strong>${esc(relatedCaseLabel(child))}</strong>`,
    child.subject ? `เรื่อง: ${esc(child.subject)}` : "",
    child.url ? `<a href="${esc(child.url)}">เปิดเคสใหม่ใน Plane</a>` : "",
  ].filter(Boolean);
  return `<p>${lines.join("<br>")}</p>`;
}

export interface ParentTicketRow {
  id: number;
  ticket_number: string;
  subject: string | null;
  status: string | null;
  closed_at: Date | null;
  plane_issue_id: string | null;
  plane_workspace_slug: string | null;
  plane_project_id: string | null;
}

export class CaseFollowUpService {
  /** The closed case the customer referenced most recently in this conversation (messages.reactions). */
  async recentClosedReference(conversationId: number, withinHours = 2): Promise<number | null> {
    try {
      const { rows } = await pool.query<{ ticket_id: string | null }>(
        `SELECT reactions->>'referenced_ticket_id' AS ticket_id
           FROM messages
          WHERE conversation_id = $1::integer
            AND COALESCE(reactions->>'referenced_ticket_id', '') <> ''
            AND created_at >= NOW() - ($2::text || ' hours')::interval
          ORDER BY id DESC LIMIT 1`,
        [conversationId, String(withinHours)]
      );
      const id = Number(rows[0]?.ticket_id || 0);
      return id > 0 ? id : null;
    } catch (err: any) {
      logger.warn({ conversationId, error: err.message }, "Could not read the recent closed-case reference");
      return null;
    }
  }

  /** Remembers "the next case in this conversation follows parentTicketId". */
  async markRequested(parentTicketId: number, conversationId: number, correlationId?: string): Promise<void> {
    await pool
      .query(
        `INSERT INTO ticket_events (ticket_id, event_type, actor, source, correlation_id, payload, created_at)
         VALUES ($1, 'FOLLOW_UP_REQUESTED', 'customer', 'line_case_resolver', $2, $3, NOW())`,
        [parentTicketId, correlationId || null, JSON.stringify({ conversation_id: conversationId, consumed: false })]
      )
      .catch((err) => logger.warn({ parentTicketId, conversationId, error: err.message }, "Could not record FOLLOW_UP_REQUESTED"));
  }

  /** The unconsumed follow-up request of this conversation, if one is recent enough. */
  async pending(conversationId: number, withinHours = 24): Promise<{ eventId: number; parentTicketId: number } | null> {
    try {
      const { rows } = await pool.query<{ id: number; ticket_id: number }>(
        `SELECT id, ticket_id FROM ticket_events
          WHERE event_type = 'FOLLOW_UP_REQUESTED'
            AND payload->>'conversation_id' = $1::text
            AND COALESCE(payload->>'consumed', 'false') <> 'true'
            AND created_at >= NOW() - ($2::text || ' hours')::interval
          ORDER BY id DESC LIMIT 1`,
        [String(conversationId), String(withinHours)]
      );
      return rows[0] ? { eventId: Number(rows[0].id), parentTicketId: Number(rows[0].ticket_id) } : null;
    } catch (err: any) {
      logger.warn({ conversationId, error: err.message }, "Could not read the pending follow-up request");
      return null;
    }
  }

  async consume(eventId: number, childTicketId: number | null): Promise<void> {
    await pool
      .query(
        `UPDATE ticket_events SET payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
        [eventId, JSON.stringify({ consumed: true, child_ticket_id: childTicketId, consumed_at: new Date().toISOString() })]
      )
      .catch((err) => logger.warn({ eventId, error: err.message }, "Could not mark the follow-up request consumed"));
  }

  async setParent(childTicketId: number, parentTicketId: number): Promise<void> {
    await pool
      .query(`UPDATE tickets SET parent_ticket_id = $2, updated_at = NOW() WHERE id = $1 AND parent_ticket_id IS NULL`, [childTicketId, parentTicketId])
      .catch((err) => logger.warn({ childTicketId, parentTicketId, error: err.message }, "Could not set parent_ticket_id"));
  }

  async loadParent(parentTicketId: number): Promise<ParentTicketRow | null> {
    try {
      const { rows } = await pool.query<ParentTicketRow>(
        `SELECT id, ticket_number, subject, status, closed_at, plane_issue_id, plane_workspace_slug, plane_project_id
           FROM tickets WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [parentTicketId]
      );
      return rows[0] ?? null;
    } catch (err: any) {
      logger.warn({ parentTicketId, error: err.message }, "Could not load the parent case");
      return null;
    }
  }
}

export const caseFollowUpService = new CaseFollowUpService();
