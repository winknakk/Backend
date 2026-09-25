import { pool } from "../adapters/postgres/PostgresAdapter";
import { createLogger } from "../observability/logger";
import { AiChatFn, AiService, CONVERSATION_SUMMARY_PROMPT_VERSION, GENERATIVE_PROVIDER } from "./aiService";
import { ConversationContextBuilder, ConversationFacts } from "./ConversationContextBuilder";
import { ConversationSummaryOutput, ConversationSummaryOutputSchema } from "../schemas/conversationSummary";

const logger = createLogger("ConversationSummaryService");

/** A generation claim older than this is treated as abandoned by a crashed process. */
const CLAIM_TIMEOUT_SECONDS = 120;

export interface SummaryProvenance {
  provider: string;
  model: string | null;
  modelVersion: string | null;
  promptVersion: string;
  generatedAt: string | null;
  sourceLastMessageId: number | null;
  messageCountAtGeneration: number;
}

export type SummaryStatus = "missing" | "generating" | "ready" | "failed";

export interface ConversationSummaryView {
  conversationId: number;
  projectId: number;
  /** Authoritative database state. */
  facts: ConversationFacts;
  /** AI interpretation; null until a valid summary has been generated. */
  summary: ConversationSummaryOutput | null;
  provenance: SummaryProvenance | null;
  /** True when messages changed after the summary was generated. */
  stale: boolean;
  status: SummaryStatus;
  lastErrorCategory: string | null;
  aiGenerated: true;
}

/**
 * Provider-neutral context contract for downstream bots. `facts` is
 * authoritative, `semantic` is an AI hint, `provenance` says how fresh it is.
 * Any state-changing action must still go through the deterministic handlers.
 */
export interface ConversationBotContext {
  facts: {
    ticketStatus: string | null;
    handoffActive: boolean;
    lastMessageAt: string | null;
  };
  semantic: {
    customerGoal: string;
    topics: string[];
    openQuestions: string[];
  } | null;
  provenance: {
    generatedAt: string | null;
    sourceLastMessageId: number | null;
    model: string | null;
    stale: boolean;
  };
}

/** Pure staleness rule: the summary no longer matches the message watermark. */
export function isSummaryStale(
  row: { source_last_message_id: number | null; source_message_count: number } | null,
  facts: Pick<ConversationFacts, "latestMessageId" | "messageCount">
): boolean {
  if (!row) return true;
  return (
    (row.source_last_message_id ?? null) !== (facts.latestMessageId ?? null) ||
    Number(row.source_message_count) !== Number(facts.messageCount)
  );
}

export class ConversationSummaryService {
  private pool: any;
  private contextBuilder: ConversationContextBuilder;
  private chat?: AiChatFn;
  private inFlight = new Map<string, Promise<ConversationSummaryView>>();

  constructor(options: { pool?: any; contextBuilder?: ConversationContextBuilder; chat?: AiChatFn } = {}) {
    this.pool = options.pool || pool;
    this.contextBuilder = options.contextBuilder || new ConversationContextBuilder(this.pool);
    this.chat = options.chat;
  }

  private async loadRow(projectId: number, conversationId: number): Promise<any | null> {
    const res = await this.pool.query(
      `SELECT * FROM conversation_summaries
        WHERE project_id = $1 AND conversation_id = $2 AND prompt_version = $3
        LIMIT 1;`,
      [projectId, conversationId, CONVERSATION_SUMMARY_PROMPT_VERSION]
    );
    return res.rows[0] || null;
  }

  private toView(projectId: number, conversationId: number, facts: ConversationFacts, row: any | null): ConversationSummaryView {
    let summary: ConversationSummaryOutput | null = null;
    if (row?.summary) {
      const raw = typeof row.summary === "string" ? JSON.parse(row.summary) : row.summary;
      const parsed = ConversationSummaryOutputSchema.safeParse(raw);
      summary = parsed.success ? parsed.data : null;
    }
    const hasSummary = summary !== null;

    return {
      conversationId,
      projectId,
      facts,
      summary,
      provenance: hasSummary
        ? {
            provider: row.provider || GENERATIVE_PROVIDER.provider,
            model: row.model ?? null,
            modelVersion: row.model_version ?? null,
            promptVersion: row.prompt_version,
            generatedAt: row.generated_at ? new Date(row.generated_at).toISOString() : null,
            sourceLastMessageId: row.source_last_message_id != null ? Number(row.source_last_message_id) : null,
            messageCountAtGeneration: Number(row.source_message_count || 0),
          }
        : null,
      stale: hasSummary ? isSummaryStale(row, facts) : true,
      status: !row ? "missing" : (row.generation_status as SummaryStatus),
      lastErrorCategory: row?.last_error_category ?? null,
      aiGenerated: true,
    };
  }

  /** Current summary plus authoritative facts. Never calls the model. */
  async getSummary(projectId: number, conversationId: number): Promise<ConversationSummaryView> {
    const facts = await this.contextBuilder.readFacts(projectId, conversationId);
    const row = await this.loadRow(projectId, conversationId);
    return this.toView(projectId, conversationId, facts, row);
  }

  toBotContext(view: ConversationSummaryView): ConversationBotContext {
    return {
      facts: {
        ticketStatus: view.facts.ticket?.status ?? null,
        handoffActive: view.facts.handoff.active,
        lastMessageAt: view.facts.lastMessageAt,
      },
      semantic: view.summary
        ? { customerGoal: view.summary.customer_goal, topics: view.summary.topics, openQuestions: view.summary.open_questions }
        : null,
      provenance: {
        generatedAt: view.provenance?.generatedAt ?? null,
        sourceLastMessageId: view.provenance?.sourceLastMessageId ?? null,
        model: view.provenance?.model ?? null,
        stale: view.stale,
      },
    };
  }

  /**
   * Regenerates the summary when it is missing or stale (or when forced).
   * Single-flight per conversation: in-process through a promise map, and
   * across processes through a claim on the summary row.
   */
  async refresh(projectId: number, conversationId: number, options: { force?: boolean } = {}): Promise<ConversationSummaryView> {
    const key = `${projectId}:${conversationId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const run = this.doRefresh(projectId, conversationId, options.force === true).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }

  private async doRefresh(projectId: number, conversationId: number, force: boolean): Promise<ConversationSummaryView> {
    const context = await this.contextBuilder.build(projectId, conversationId);
    const current = await this.loadRow(projectId, conversationId);
    const currentView = this.toView(projectId, conversationId, context.facts, current);

    if (!force && currentView.summary && !currentView.stale) {
      return currentView;
    }
    if (context.transcript.length === 0) {
      return currentView;
    }

    const claim = await this.pool.query(
      `INSERT INTO conversation_summaries
         (project_id, conversation_id, prompt_version, generation_status, generation_started_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'generating', NOW(), NOW(), NOW())
       ON CONFLICT (project_id, conversation_id, prompt_version) DO UPDATE SET
         generation_status = 'generating',
         generation_started_at = NOW(),
         updated_at = NOW()
       WHERE conversation_summaries.generation_status <> 'generating'
          OR conversation_summaries.generation_started_at < NOW() - make_interval(secs => $4)
       RETURNING id;`,
      [projectId, conversationId, CONVERSATION_SUMMARY_PROMPT_VERSION, CLAIM_TIMEOUT_SECONDS]
    );
    if (claim.rows.length === 0) {
      // Another process is generating right now.
      return { ...currentView, status: "generating" };
    }

    const result = await AiService.summarizeConversation(
      { projectId, conversationId, transcript: context.transcript, omittedMessages: context.omittedMessages },
      this.chat
    );

    if (result.ok) {
      await this.pool.query(
        `UPDATE conversation_summaries SET
           summary = $4::jsonb,
           generation_status = 'ready',
           source_last_message_id = $5,
           source_message_count = $6,
           provider = $7,
           model = $8,
           model_version = $9,
           generated_at = NOW(),
           last_error_category = NULL,
           last_attempt_at = NOW(),
           updated_at = NOW()
         WHERE project_id = $1 AND conversation_id = $2 AND prompt_version = $3;`,
        [
          projectId,
          conversationId,
          CONVERSATION_SUMMARY_PROMPT_VERSION,
          JSON.stringify(result.value),
          context.facts.latestMessageId,
          context.facts.messageCount,
          GENERATIVE_PROVIDER.provider,
          GENERATIVE_PROVIDER.model,
          GENERATIVE_PROVIDER.modelVersion,
        ]
      );
    } else {
      // Keep the previous valid summary (it stays visibly stale); record why
      // this attempt failed. Provider error text is never stored or returned.
      logger.warn({ projectId, conversationId, errorCategory: result.errorCategory }, "Conversation summary generation failed");
      await this.pool.query(
        `UPDATE conversation_summaries SET
           generation_status = CASE WHEN summary IS NULL THEN 'failed' ELSE 'ready' END,
           last_error_category = $4,
           last_attempt_at = NOW(),
           updated_at = NOW()
         WHERE project_id = $1 AND conversation_id = $2 AND prompt_version = $3;`,
        [projectId, conversationId, CONVERSATION_SUMMARY_PROMPT_VERSION, result.errorCategory]
      );
    }

    const row = await this.loadRow(projectId, conversationId);
    return this.toView(projectId, conversationId, context.facts, row);
  }
}
