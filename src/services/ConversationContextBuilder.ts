import { pool } from "../adapters/postgres/PostgresAdapter";

/**
 * Project-scoped context for conversation-level AI work.
 *
 * Two outputs, kept apart on purpose:
 *  - `facts`: authoritative database state (ids, ticket, handoff, counts).
 *    Shown to operators as-is and never sent to a model.
 *  - `transcript`: PII-minimized, trimmed customer / bot / agent messages in
 *    chronological order — the only material a model sees.
 *
 * Internal notes live in the `internal_notes` table and are never read here.
 * Callers must have authorized the project before calling; the builder also
 * refuses a conversation that is not in the stated project.
 */

export class ConversationNotFoundError extends Error {
  constructor(projectId: number, conversationId: number) {
    super(`conversation_not_found: conversation ${conversationId} is not in project ${projectId}`);
    this.name = "ConversationNotFoundError";
  }
}

export interface ConversationFacts {
  conversationId: number;
  projectId: number;
  channel: string | null;
  conversationStatus: string | null;
  handledBy: string | null;
  takeoverState: string | null;
  operatorId: string | null;
  createdAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  latestMessageId: number | null;
  ticket: { id: number; ticketNumber: string | null; status: string | null } | null;
  handoff: { count: number; lastStartedAt: string | null; active: boolean };
}

export type TranscriptSpeaker = "customer" | "bot" | "agent" | "system";

export interface TranscriptLine {
  speaker: TranscriptSpeaker;
  text: string;
}

export interface ConversationContext {
  facts: ConversationFacts;
  transcript: TranscriptLine[];
  omittedMessages: number;
}

export const CONTEXT_LIMITS = {
  headMessages: 2,
  tailMessages: 40,
  maxMessageChars: 800,
  maxTotalChars: 12000,
};

/**
 * Replaces direct identifiers with typed placeholders before text leaves the
 * backend. Best-effort and conservative: it minimizes, it does not guarantee
 * anonymity.
 */
export function minimizePii(text: string): string {
  return (
    text
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
      .replace(/\bU[0-9a-f]{32}\b/g, "[line_id]")
      .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1")
      .replace(/(?:\+?66|\b0)[\s-]?\d{1,2}[\s-]?\d{3}[\s-]?\d{3,4}\b/g, "[phone]")
      // National ids, account and card numbers: any 9+ digit run.
      .replace(/\d(?:[\s-]?\d){8,}/g, "[number]")
  );
}

function speakerFor(role: string, purpose: string | null): TranscriptSpeaker {
  const r = (role || "").toLowerCase();
  if (r === "customer" || r === "user") return "customer";
  if (r === "ai") return purpose === "notification" ? "system" : "bot";
  if (r === "human" || r === "agent" || r === "operator") return "agent";
  return "system";
}

function messageText(row: any): string {
  const type = String(row.message_type || "text").toLowerCase();
  if (type !== "text") return `[${type}]`;
  const content = typeof row.content === "string" ? row.content : "";
  return content.trim();
}

/** Keeps the opening and the most recent messages within the character budget. */
export function trimTranscript(
  lines: TranscriptLine[],
  limits = CONTEXT_LIMITS
): { transcript: TranscriptLine[]; omitted: number } {
  const clipped = lines.map((l) => ({
    speaker: l.speaker,
    text: l.text.length > limits.maxMessageChars ? `${l.text.slice(0, limits.maxMessageChars)}…` : l.text,
  }));

  let head = clipped.slice(0, Math.min(limits.headMessages, clipped.length));
  let tail = clipped.slice(head.length).slice(-limits.tailMessages);
  const size = (xs: TranscriptLine[]) => xs.reduce((n, l) => n + l.text.length, 0);

  while (tail.length > 1 && size(head) + size(tail) > limits.maxTotalChars) {
    tail = tail.slice(1);
  }
  if (size(head) + size(tail) > limits.maxTotalChars) head = [];

  const omitted = clipped.length - head.length - tail.length;
  return { transcript: [...head, ...tail], omitted };
}

export class ConversationContextBuilder {
  private pool: any;

  constructor(customPool?: any) {
    this.pool = customPool || pool;
  }

  async readFacts(projectId: number, conversationId: number): Promise<ConversationFacts> {
    const convRes = await this.pool.query(
      `SELECT id, project_id, channel, status, handled_by, takeover_state, operator_id,
              active_ticket_id, last_message_at, created_at
         FROM conversations
        WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
        LIMIT 1;`,
      [conversationId, projectId]
    );
    if (convRes.rows.length === 0) {
      throw new ConversationNotFoundError(projectId, conversationId);
    }
    const conv = convRes.rows[0];

    const [watermarkRes, ticketRes, handoffRes] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::int AS message_count,
                (SELECT id FROM messages
                  WHERE conversation_id = $1 AND deleted_at IS NULL
                  ORDER BY created_at DESC, id DESC LIMIT 1) AS latest_message_id
           FROM messages
          WHERE conversation_id = $1 AND deleted_at IS NULL;`,
        [conversationId]
      ),
      // Same selection as the CRM profile route: the focused ticket first,
      // else the newest ticket of this conversation. Read-only use of
      // active_ticket_id, and always inside the conversation's project.
      this.pool.query(
        `SELECT id, ticket_number, status
           FROM tickets
          WHERE project_id = $3
            AND deleted_at IS NULL
            AND (id = $1::integer OR conversation_id = $2::integer)
          ORDER BY (id = $1::integer) DESC, id DESC
          LIMIT 1;`,
        [conv.active_ticket_id ?? null, conversationId, projectId]
      ),
      this.pool.query(
        `SELECT count(*)::int AS handoff_count,
                max(started_at) AS last_started_at,
                COALESCE(bool_or(ended_at IS NULL AND started_at IS NOT NULL), false) AS active
           FROM conversation_handoffs
          WHERE conversation_id = $1;`,
        [conversationId]
      ),
    ]);

    const iso = (v: any) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
    const t = ticketRes.rows[0];
    const h = handoffRes.rows[0] || {};
    const w = watermarkRes.rows[0] || {};

    return {
      conversationId: Number(conv.id),
      projectId: Number(conv.project_id),
      channel: conv.channel ?? null,
      conversationStatus: conv.status ?? null,
      handledBy: conv.handled_by ?? null,
      takeoverState: conv.takeover_state ?? null,
      operatorId: conv.operator_id ?? null,
      createdAt: iso(conv.created_at),
      lastMessageAt: iso(conv.last_message_at),
      messageCount: Number(w.message_count || 0),
      latestMessageId: w.latest_message_id != null ? Number(w.latest_message_id) : null,
      ticket: t ? { id: Number(t.id), ticketNumber: t.ticket_number ?? null, status: t.status ?? null } : null,
      handoff: {
        count: Number(h.handoff_count || 0),
        lastStartedAt: iso(h.last_started_at),
        active: h.active === true,
      },
    };
  }

  async build(projectId: number, conversationId: number): Promise<ConversationContext> {
    const facts = await this.readFacts(projectId, conversationId);

    const msgRes = await this.pool.query(
      `SELECT m.id, m.role, m.content, m.message_type, m.message_purpose
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = $1
          AND c.project_id = $2
          AND m.deleted_at IS NULL
        ORDER BY m.created_at ASC, m.id ASC;`,
      [conversationId, projectId]
    );

    const lines: TranscriptLine[] = [];
    for (const row of msgRes.rows) {
      const text = messageText(row);
      if (!text) continue;
      lines.push({ speaker: speakerFor(String(row.role), row.message_purpose ?? null), text: minimizePii(text) });
    }

    const { transcript, omitted } = trimTranscript(lines);
    return { facts, transcript, omittedMessages: omitted };
  }
}
