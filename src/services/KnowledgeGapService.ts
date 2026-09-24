import { pool } from "../adapters/postgres/PostgresAdapter";
import { createLogger } from "../observability/logger";
import { INTELLIGENCE_CONFIG } from "../config/intelligence";
import { EmbeddingService } from "../rag/EmbeddingService";

const logger = createLogger("KnowledgeGapService");

export interface SignalEvaluationDetails {
  score: number;
  details: Record<string, any>;
}

export interface KnowledgeGapEvidence {
  signals: {
    lowRetrieval: SignalEvaluationDetails;
    customerRephrasing: SignalEvaluationDetails;
    evasiveResponse: SignalEvaluationDetails;
    immediateTakeover: SignalEvaluationDetails;
  };
  weights: typeof INTELLIGENCE_CONFIG.weights;
  threshold: number;
  calculatedAt: string;
}

export interface CandidateEvaluationInput {
  projectId: number;
  conversationId: number;
  messageId: number;
  queryText: string;
  aiResponseText?: string;
  retrievalConfidence?: number;
  retrievedDocsCount?: number;
  messageCreatedAt?: Date | string;
}

export interface KnowledgeGapCandidateRecord {
  id: number;
  projectId: number;
  conversationId: number | null;
  messageId: number | null;
  queryText: string;
  normalizedQuery: string;
  score: number;
  evidence: KnowledgeGapEvidence;
  status: "open" | "reviewed" | "resolved" | "ignored";
  clusterId: string | null;
  reviewNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  modelVersion: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The job's (project, conversation, message) triple does not exist as a unit.
 * Retrying cannot fix it; the message text is chosen so the outbox failure
 * classifier treats it as permanent.
 */
export class KnowledgeGapTurnNotFoundError extends Error {
  constructor(projectId: number, conversationId: number, messageId: number) {
    super(
      `conversation_not_found: message ${messageId} is not a message of conversation ${conversationId} in project ${projectId}`
    );
    this.name = "KnowledgeGapTurnNotFoundError";
  }
}

export interface PendingTurn {
  projectId: number;
  conversationId: number;
  messageId: number;
}

/** Customer-authored message roles in the live `messages` table. */
const CUSTOMER_ROLES = ["customer", "user"];

export interface ClusterSummary {
  clusterId: string;
  projectId: number;
  topic: string;
  inquiryCount: number;
  uniqueProfilesCount: number;
  sampleQueries: string[];
  candidateIds: number[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export class KnowledgeGapService {
  private pool: any;
  private embeddingService: EmbeddingService;

  constructor(customPool?: any, customEmbeddingService?: EmbeddingService) {
    this.pool = customPool || pool;
    this.embeddingService = customEmbeddingService || new EmbeddingService();
  }

  /**
   * Normalizes customer query text: lowercase, trimmed, punctuation stripped, normalized whitespace.
   */
  normalizeQuery(text: string): string {
    return (text || "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Signal 1: Low Retrieval Confidence Evaluation
   * Evaluates if knowledge retrieval returned low confidence (< 0.65) or 0 documents.
   */
  async evaluateLowRetrieval(
    projectId: number,
    conversationId: number,
    retrievalConfidence?: number,
    retrievedDocsCount?: number
  ): Promise<SignalEvaluationDetails> {
    const threshold = INTELLIGENCE_CONFIG.thresholds.lowRetrievalConfidence; // 0.65

    // If explicit retrieval stats were supplied
    if (retrievalConfidence !== undefined) {
      const conf = Math.max(0, Math.min(1, retrievalConfidence));
      const count = retrievedDocsCount !== undefined ? retrievedDocsCount : 1;
      if (count === 0 || conf < threshold) {
        return {
          score: 1.0,
          details: { retrievalConfidence: conf, retrievedDocsCount: count, source: "explicit_args" },
        };
      }
      return {
        score: 0.0,
        details: { retrievalConfidence: conf, retrievedDocsCount: count, source: "explicit_args" },
      };
    }

    // Inspect execution traces for this conversation
    try {
      const traceRes = await this.pool.query(
        `SELECT tool_name, status, called_at
         FROM traces
         WHERE conversation_id = $1::text
           AND tool_name IN ('search_project_docs', 'search_codebase', 'knowledge_search', 'rag_retrieve')
         ORDER BY called_at DESC
         LIMIT 3;`,
        [conversationId]
      );

      if (traceRes.rows.length === 0) {
        // No retrieval tool was executed for this conversation
        return {
          score: 0.0,
          details: { traceCount: 0, reason: "no_retrieval_trace_found" },
        };
      }

      // Check if any recent retrieval trace failed or returned empty
      const lastTrace = traceRes.rows[0];
      const traceFailed = lastTrace.status === "error" || lastTrace.status === "failed";
      return {
        score: traceFailed ? 1.0 : 0.0,
        details: { lastTraceTool: lastTrace.tool_name, status: lastTrace.status, source: "traces_table" },
      };
    } catch (err: any) {
      logger.warn({ error: err.message, conversationId }, "Failed to evaluate low retrieval trace");
      return { score: 0.0, details: { error: err.message } };
    }
  }

  /**
   * Signal 2: Customer Rephrasing Evaluation
   * Checks if customer rephrased or repeated inquiry within rephrasing window (300s).
   */
  async evaluateCustomerRephrasing(
    projectId: number,
    conversationId: number,
    currentQuery: string,
    messageCreatedAt?: Date | string,
    excludeMessageId?: number
  ): Promise<SignalEvaluationDetails> {
    const windowSecs = INTELLIGENCE_CONFIG.windows.rephrasingWindowSeconds; // 300s
    const normCurrent = this.normalizeQuery(currentQuery);

    if (!normCurrent || normCurrent.length < 3) {
      return { score: 0.0, details: { reason: "query_too_short" } };
    }

    try {
      const refTime = messageCreatedAt ? new Date(messageCreatedAt) : new Date();
      const cutoffTime = new Date(refTime.getTime() - windowSecs * 1000);

      // Look for prior user messages in same conversation within 300s, excluding current turn
      const prevMsgRes = await this.pool.query(
        `SELECT m.id, m.content, m.created_at
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.conversation_id = $1
           AND c.project_id = $2
           AND (m.role = 'user' OR m.role = 'customer')
           AND ($5::integer IS NULL OR m.id != $5)
           AND m.created_at <= $3
           AND m.created_at >= $4
         ORDER BY m.created_at DESC
         LIMIT 3;`,
        [conversationId, projectId, refTime, cutoffTime, excludeMessageId || null]
      );

      if (prevMsgRes.rows.length === 0) {
        return { score: 0.0, details: { reason: "no_prior_user_message_in_window" } };
      }

      // Extract word segments using Intl.Segmenter supporting Thai and international scripts
      const segmenter = new Intl.Segmenter(["th", "en"], { granularity: "word" });
      const extractTokens = (txt: string): Set<string> => {
        return new Set(
          [...segmenter.segment(txt)]
            .filter((s) => s.isWordLike)
            .map((s) => s.segment.toLowerCase().trim())
            .filter((w) => w.length > 0)
        );
      };

      const currentTokens = extractTokens(normCurrent);
      let maxSimilarity = 0.0;
      let matchedMsgId: number | null = null;

      for (const row of prevMsgRes.rows) {
        const prevTokens = extractTokens(row.content);
        if (prevTokens.size === 0) continue;

        let intersection = 0;
        for (const t of currentTokens) {
          if (prevTokens.has(t)) intersection++;
        }
        const union = new Set([...currentTokens, ...prevTokens]).size;
        const jaccard = union > 0 ? intersection / union : 0;
        const minSize = Math.min(currentTokens.size, prevTokens.size);
        const overlap = minSize > 0 ? intersection / minSize : 0;

        const effectiveSim = Math.max(jaccard, overlap * 0.7);
        if (effectiveSim > maxSimilarity) {
          maxSimilarity = effectiveSim;
          matchedMsgId = row.id;
        }
      }

      // If token similarity is >= 0.20 (rephrasing or repeating unaddressed inquiry)
      const isRephrased = maxSimilarity >= 0.20;
      return {
        score: isRephrased ? 1.0 : 0.0,
        details: {
          similarity: Number(maxSimilarity.toFixed(4)),
          matchedMessageId: matchedMsgId,
          rephrased: isRephrased,
        },
      };
    } catch (err: any) {
      logger.warn({ error: err.message, conversationId }, "Failed to evaluate customer rephrasing");
      return { score: 0.0, details: { error: err.message } };
    }
  }

  /**
   * Signal 3: Evasive / Apology Response Evaluation
   * Deterministic matching of apologetic, deflection, or out-of-scope phrases in AI reply.
   */
  evaluateEvasiveResponse(aiReplyText?: string): SignalEvaluationDetails {
    if (!aiReplyText || typeof aiReplyText !== "string") {
      return { score: 0.0, details: { reason: "no_ai_reply_provided" } };
    }

    const lower = aiReplyText.toLowerCase();

    // Standard Thai evasive / apology / unable-to-answer phrases
    const thaiEvasivePatterns = [
      "ขออภัย",
      "ไม่พบข้อมูล",
      "ไม่สามารถตอบ",
      "ยังไม่มีข้อมูล",
      "ไม่แน่ใจ",
      "ขออภัยในความไม่สะดวก",
      "แนะนำให้ติดต่อเจ้าหน้าที่",
      "อยู่นอกเหนือขอบเขต",
      "เกินขอบเขตความสามารถ",
      "ไม่ทราบข้อมูล",
    ];

    // Standard English evasive / apology phrases
    const engEvasivePatterns = [
      "i do not have information",
      "i don't have information",
      "i cannot find",
      "i am unable to answer",
      "i apologize, but",
      "i apologize for",
      "i don't know",
      "outside my knowledge",
      "beyond my capabilities",
      "please contact our support",
      "i am sorry, but i cannot",
    ];

    const matchedThai = thaiEvasivePatterns.filter((p) => lower.includes(p));
    const matchedEng = engEvasivePatterns.filter((p) => lower.includes(p));
    const allMatches = [...matchedThai, ...matchedEng];

    const isEvasive = allMatches.length > 0;
    return {
      score: isEvasive ? 1.0 : 0.0,
      details: {
        isEvasive,
        matchedPatterns: allMatches,
      },
    };
  }

  /**
   * Signal 4: Immediate Takeover Evaluation
   * Detects human takeover within handoff window (120s) following the message.
   */
  async evaluateImmediateTakeover(
    projectId: number,
    conversationId: number,
    messageCreatedAt?: Date | string
  ): Promise<SignalEvaluationDetails> {
    const windowSecs = INTELLIGENCE_CONFIG.windows.handoffWindowSeconds; // 120s
    const refTime = messageCreatedAt ? new Date(messageCreatedAt) : new Date();
    const windowEnd = new Date(refTime.getTime() + windowSecs * 1000);

    try {
      const handoffRes = await this.pool.query(
        `SELECT id, from_handler, to_handler, started_at
         FROM conversation_handoffs
         WHERE conversation_id = $1
           AND (from_handler = 'ai' OR from_handler IS NULL)
           AND started_at >= $2
           AND started_at <= $3
         ORDER BY started_at ASC
         LIMIT 1;`,
        [conversationId, refTime, windowEnd]
      );

      if (handoffRes.rows.length > 0) {
        const h = handoffRes.rows[0];
        return {
          score: 1.0,
          details: { handoffId: h.id, startedAt: h.started_at, fromHandler: h.from_handler, toHandler: h.to_handler },
        };
      }

      return {
        score: 0.0,
        details: { handoffObserved: false },
      };
    } catch (err: any) {
      logger.warn({ error: err.message, conversationId }, "Failed to evaluate immediate takeover");
      return { score: 0.0, details: { error: err.message } };
    }
  }

  /**
   * Evaluates all 4 signals, calculates weighted score, and upserts candidate if score >= 0.50.
   */
  async evaluateAndPersistCandidate(
    input: CandidateEvaluationInput
  ): Promise<{ isCandidate: boolean; score: number; candidate?: KnowledgeGapCandidateRecord; evidence: KnowledgeGapEvidence }> {
    const { projectId, conversationId, messageId, queryText, aiResponseText, retrievalConfidence, retrievedDocsCount, messageCreatedAt } = input;

    // 1. Evaluate all 4 signals concurrently
    const [lowRet, rephrasing, evasive, takeover] = await Promise.all([
      this.evaluateLowRetrieval(projectId, conversationId, retrievalConfidence, retrievedDocsCount),
      this.evaluateCustomerRephrasing(projectId, conversationId, queryText, messageCreatedAt, messageId),
      Promise.resolve(this.evaluateEvasiveResponse(aiResponseText)),
      this.evaluateImmediateTakeover(projectId, conversationId, messageCreatedAt),
    ]);

    // 2. Weighted candidate scoring
    const w = INTELLIGENCE_CONFIG.weights;
    const weightedScore = Number((
      (w.lowRetrieval * lowRet.score) +
      (w.customerRephrasing * rephrasing.score) +
      (w.evasiveResponse * evasive.score) +
      (w.immediateTakeover * takeover.score)
    ).toFixed(4));

    const threshold = INTELLIGENCE_CONFIG.thresholds.knowledgeGapScore; // 0.50
    const isCandidate = weightedScore >= threshold;

    const evidence: KnowledgeGapEvidence = {
      signals: {
        lowRetrieval: lowRet,
        customerRephrasing: rephrasing,
        evasiveResponse: evasive,
        immediateTakeover: takeover,
      },
      weights: w,
      threshold,
      calculatedAt: new Date().toISOString(),
    };

    if (!isCandidate) {
      return { isCandidate: false, score: weightedScore, evidence };
    }

    // 3. Durable persistence with ON CONFLICT idempotency
    const normQuery = this.normalizeQuery(queryText);
    const modelVersion = INTELLIGENCE_CONFIG.versions.modelVersion; // "v1"

    const insertSql = `
      INSERT INTO knowledge_gap_candidates (
        project_id,
        conversation_id,
        message_id,
        query_text,
        normalized_query,
        score,
        evidence,
        status,
        model_version,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'open', $8, NOW(), NOW())
      ON CONFLICT (project_id, conversation_id, message_id, model_version)
      DO UPDATE SET
        score = EXCLUDED.score,
        evidence = EXCLUDED.evidence,
        normalized_query = EXCLUDED.normalized_query,
        updated_at = NOW()
      WHERE knowledge_gap_candidates.status = 'open'
      RETURNING *;
    `;

    const res = await this.pool.query(insertSql, [
      projectId,
      conversationId,
      messageId,
      queryText,
      normQuery,
      weightedScore,
      JSON.stringify(evidence),
      modelVersion,
    ]);

    const row = res.rows[0] || null;
    const candidate: KnowledgeGapCandidateRecord | undefined = row ? this.mapCandidateRow(row) : undefined;

    return {
      isCandidate: true,
      score: weightedScore,
      candidate,
      evidence,
    };
  }

  /**
   * Evaluates one customer turn from authoritative database state.
   *
   * Only ids are taken from the caller. The message text, its timestamp and
   * the bot reply are read here, and the message must belong to the stated
   * conversation inside the stated project — a job carrying a mismatched
   * project id is rejected rather than evaluated against another tenant's data.
   */
  async evaluateTurn(
    projectId: number,
    conversationId: number,
    messageId: number
  ): Promise<
    | { skipped: string }
    | { skipped?: undefined; isCandidate: boolean; score: number; candidate?: KnowledgeGapCandidateRecord; evidence: KnowledgeGapEvidence }
  > {
    const msgRes = await this.pool.query(
      `SELECT m.id, m.role, m.content, m.created_at
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = $3
          AND m.conversation_id = $2
          AND c.project_id = $1
          AND m.deleted_at IS NULL
          AND c.deleted_at IS NULL
        LIMIT 1;`,
      [projectId, conversationId, messageId]
    );
    if (msgRes.rows.length === 0) {
      throw new KnowledgeGapTurnNotFoundError(projectId, conversationId, messageId);
    }

    const msg = msgRes.rows[0];
    if (!CUSTOMER_ROLES.includes(String(msg.role))) {
      return { skipped: "not_customer_message" };
    }
    const queryText = typeof msg.content === "string" ? msg.content.trim() : "";
    if (!queryText) {
      return { skipped: "empty_customer_message" };
    }

    // The bot's direct answer: the first AI reply after this message and
    // before the customer's next message. System chips and notifications
    // (message_purpose set) are not answers and are not judged as evasive.
    const replyRes = await this.pool.query(
      `SELECT r.content
         FROM messages r
        WHERE r.conversation_id = $1
          AND r.role = 'ai'
          AND r.message_purpose IS NULL
          AND r.deleted_at IS NULL
          AND r.created_at >= $2
          AND NOT EXISTS (
            SELECT 1 FROM messages n
             WHERE n.conversation_id = $1
               AND n.role = ANY($3::text[])
               AND n.deleted_at IS NULL
               AND n.created_at > $2
               AND n.created_at < r.created_at
          )
        ORDER BY r.created_at ASC, r.id ASC
        LIMIT 1;`,
      [conversationId, msg.created_at, CUSTOMER_ROLES]
    );

    return this.evaluateAndPersistCandidate({
      projectId,
      conversationId,
      messageId,
      queryText,
      aiResponseText: replyRes.rows[0]?.content ?? undefined,
      messageCreatedAt: msg.created_at,
    });
  }

  /**
   * Customer turns whose handoff window has elapsed, that the bot answered,
   * and that have no candidate yet for the current model version. Returns ids
   * only; each id triple is evaluated as its own single-project job.
   */
  async findTurnsPendingEvaluation(lookbackSeconds: number, limit: number): Promise<PendingTurn[]> {
    const res = await this.pool.query(
      `SELECT c.project_id, m.conversation_id, m.id AS message_id
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.role = ANY($1::text[])
          AND m.deleted_at IS NULL
          AND c.deleted_at IS NULL
          AND c.project_id IS NOT NULL
          AND COALESCE(m.message_type, 'text') = 'text'
          AND m.created_at <= NOW() - make_interval(secs => $2)
          AND m.created_at >  NOW() - make_interval(secs => $3)
          AND EXISTS (
            SELECT 1 FROM messages r
             WHERE r.conversation_id = m.conversation_id
               AND r.role = 'ai'
               AND r.message_purpose IS NULL
               AND r.deleted_at IS NULL
               AND r.created_at >= m.created_at
          )
          AND NOT EXISTS (
            SELECT 1 FROM knowledge_gap_candidates k
             WHERE k.message_id = m.id AND k.model_version = $4
          )
        ORDER BY m.created_at ASC
        LIMIT $5;`,
      [
        CUSTOMER_ROLES,
        INTELLIGENCE_CONFIG.windows.handoffWindowSeconds,
        lookbackSeconds,
        INTELLIGENCE_CONFIG.versions.modelVersion,
        limit,
      ]
    );
    return res.rows.map((r: any) => ({
      projectId: Number(r.project_id),
      conversationId: Number(r.conversation_id),
      messageId: Number(r.message_id),
    }));
  }

  /** Projects with open, unclustered candidates inside the clustering evidence window. */
  async findProjectsNeedingClustering(): Promise<number[]> {
    const windowStart = new Date(Date.now() - INTELLIGENCE_CONFIG.clustering.evidenceWindowDays * 86400000);
    const res = await this.pool.query(
      `SELECT DISTINCT project_id
         FROM knowledge_gap_candidates
        WHERE status = 'open' AND cluster_id IS NULL AND created_at >= $1;`,
      [windowStart]
    );
    return res.rows.map((r: any) => Number(r.project_id));
  }

  /**
   * Updates review lifecycle status of a candidate.
   * Validates project authorization and allowed statuses.
   */
  async updateCandidateStatus(
    candidateId: number,
    status: "open" | "reviewed" | "resolved" | "ignored",
    reviewNotes?: string,
    reviewedBy?: string,
    authorizedProjectIds: number[] | null = null
  ): Promise<KnowledgeGapCandidateRecord | null> {
    const validStatuses = ["open", "reviewed", "resolved", "ignored"];
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid candidate status: ${status}. Must be one of ${validStatuses.join(", ")}`);
    }

    // 1. Verify candidate exists & project authorization
    const checkRes = await this.pool.query(
      `SELECT id, project_id, status FROM knowledge_gap_candidates WHERE id = $1;`,
      [candidateId]
    );
    if (checkRes.rows.length === 0) {
      return null;
    }

    const cand = checkRes.rows[0];
    if (authorizedProjectIds !== null && !authorizedProjectIds.includes(cand.project_id)) {
      throw new Error(`Unauthorized: Candidate ${candidateId} belongs to project ${cand.project_id}`);
    }

    // 2. Perform lifecycle transition
    const updateSql = `
      UPDATE knowledge_gap_candidates
      SET status = $1,
          review_notes = COALESCE($2, review_notes),
          reviewed_by = COALESCE($3, reviewed_by),
          reviewed_at = NOW(),
          updated_at = NOW()
      WHERE id = $4
      RETURNING *;
    `;

    const res = await this.pool.query(updateSql, [
      status,
      reviewNotes !== undefined ? reviewNotes : null,
      reviewedBy || "operator",
      candidateId,
    ]);

    return res.rows.length > 0 ? this.mapCandidateRow(res.rows[0]) : null;
  }

  /**
   * Cosine similarity between two dense numeric vectors with optional lexical token fallback boost.
   */
  calculateCosineSimilarity(vecA: number[], vecB: number[], textA?: string, textB?: string): number {
    let sim = 0;
    if (vecA && vecB && vecA.length === vecB.length) {
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
      }
      if (normA > 0 && normB > 0) {
        sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
      }
    }

    // Lexical token overlap fallback boost for local/mock environments without external embedding API
    if (textA && textB) {
      const seg = new Intl.Segmenter(["th", "en"], { granularity: "word" });
      const extractTokens = (t: string) =>
        new Set([...seg.segment(t)].filter((s) => s.isWordLike).map((s) => s.segment.toLowerCase()));
      const tA = extractTokens(textA);
      const tB = extractTokens(textB);
      if (tA.size > 0 && tB.size > 0) {
        let inter = 0;
        for (const token of tA) {
          if (tB.has(token)) inter++;
        }
        const minSize = Math.min(tA.size, tB.size);
        const overlap = inter / minSize;
        if (overlap >= 0.50) {
          sim = Math.max(sim, 0.80 + 0.15 * overlap);
        }
      }
    }

    return sim;
  }

  /**
   * Semantic clustering of unanswered query candidates for a project.
   * Safeguards enforced:
   * 1. Hard project partitioning (WHERE project_id = $1)
   * 2. Evidence window: 7 days (INTELLIGENCE_CONFIG.clustering.evidenceWindowDays)
   * 3. Minimum inquiries: >= 3
   * 4. Minimum unique customer profiles: >= 2
   * 5. Cosine similarity threshold: >= 0.80
   */
  async runClusteringForProject(
    projectId: number
  ): Promise<{ clustersCreated: number; clusters: ClusterSummary[]; similarityBasis?: "semantic_embeddings" | "lexical_only" }> {
    const { minInquiries, minUniqueProfiles, evidenceWindowDays, similarityThreshold } = INTELLIGENCE_CONFIG.clustering;
    const windowStart = new Date(Date.now() - evidenceWindowDays * 86400000);

    // 1. Fetch unclustered 'open' candidates within evidence window strictly partitioned by project
    const fetchSql = `
      SELECT 
        kgc.id, 
        kgc.query_text, 
        kgc.normalized_query, 
        kgc.conversation_id, 
        kgc.created_at,
        c.identity_id
      FROM knowledge_gap_candidates kgc
      LEFT JOIN conversations c ON c.id = kgc.conversation_id
      WHERE kgc.project_id = $1
        AND kgc.status = 'open'
        AND kgc.created_at >= $2
      ORDER BY kgc.created_at DESC;
    `;

    const candidatesRes = await this.pool.query(fetchSql, [projectId, windowStart]);
    const candidates = candidatesRes.rows;

    if (candidates.length < minInquiries) {
      logger.info({ projectId, count: candidates.length, minInquiries }, "Insufficient candidates for clustering");
      return { clustersCreated: 0, clusters: [] };
    }

    // 2. Compute embeddings for candidate queries. A mock vector is a hash of
    // the text, not a meaning: it is discarded so similarity comes from lexical
    // overlap alone, and the run is labelled as such.
    const embeddings: Array<{ id: number; query: string; identityId: string | null; createdAt: Date; vector: number[] }> = [];
    let mockVectorCount = 0;
    const fallbackReasons = new Set<string>();

    for (const c of candidates) {
      const q = c.normalized_query || c.query_text;
      try {
        const detailed = await this.embeddingService.embedQueryDetailed(q);
        if (detailed.source === "mock") {
          mockVectorCount++;
          if (detailed.fallbackReason) fallbackReasons.add(detailed.fallbackReason);
        }
        embeddings.push({
          id: c.id,
          query: c.query_text,
          identityId: c.identity_id ? String(c.identity_id) : `anon_${c.conversation_id || c.id}`,
          createdAt: new Date(c.created_at),
          vector: detailed.source === "external" ? detailed.vector : [],
        });
      } catch (err: any) {
        logger.warn({ error: err.message, candidateId: c.id }, "Failed to generate embedding for clustering");
      }
    }

    const similarityBasis: "semantic_embeddings" | "lexical_only" =
      mockVectorCount === 0 && embeddings.length > 0 ? "semantic_embeddings" : "lexical_only";
    if (mockVectorCount > 0) {
      logger.warn(
        { projectId, mockVectorCount, total: embeddings.length, reasons: [...fallbackReasons] },
        "Knowledge gap clustering has no real embeddings for some candidates; similarity is lexical only for those"
      );
    }

    // 3. Cluster formation using leader/density grouping with similarityThreshold >= 0.80
    const assignedIds = new Set<number>();
    const formedClusters: ClusterSummary[] = [];

    for (let i = 0; i < embeddings.length; i++) {
      const seed = embeddings[i];
      if (assignedIds.has(seed.id)) continue;

      const clusterMembers: typeof embeddings = [seed];

      for (let j = i + 1; j < embeddings.length; j++) {
        const candidate = embeddings[j];
        if (assignedIds.has(candidate.id)) continue;

        const sim = this.calculateCosineSimilarity(seed.vector, candidate.vector, seed.query, candidate.query);
        if (sim >= similarityThreshold) {
          clusterMembers.push(candidate);
        }
      }

      // 4. Verify cluster safeguards: minInquiries (3) and minUniqueProfiles (2)
      const uniqueProfiles = new Set(clusterMembers.map((m) => m.identityId));
      if (clusterMembers.length >= minInquiries && uniqueProfiles.size >= minUniqueProfiles) {
        // Safe qualified cluster
        const clusterId = `kgc_cluster_p${projectId}_${Date.now()}_${formedClusters.length + 1}`;
        const memberIds = clusterMembers.map((m) => m.id);

        for (const id of memberIds) {
          assignedIds.add(id);
        }

        // Generate representative topic (use cleanest inquiry or centroid)
        const representativeTopic = `Unanswered: ${seed.query.slice(0, 80)}`;

        formedClusters.push({
          clusterId,
          projectId,
          topic: representativeTopic,
          inquiryCount: clusterMembers.length,
          uniqueProfilesCount: uniqueProfiles.size,
          sampleQueries: clusterMembers.map((m) => m.query).slice(0, 5),
          candidateIds: memberIds,
          firstSeenAt: new Date(Math.min(...clusterMembers.map((m) => m.createdAt.getTime()))).toISOString(),
          lastSeenAt: new Date(Math.max(...clusterMembers.map((m) => m.createdAt.getTime()))).toISOString(),
        });

        // 5. Persist cluster_id on candidate rows
        await this.pool.query(
          `UPDATE knowledge_gap_candidates
           SET cluster_id = $1, updated_at = NOW()
           WHERE id = ANY($2::integer[]) AND project_id = $3;`,
          [clusterId, memberIds, projectId]
        );
      }
    }

    logger.info(
      { projectId, candidatesEvaluated: candidates.length, clustersFormed: formedClusters.length, similarityBasis },
      "Knowledge gap clustering completed"
    );

    return {
      clustersCreated: formedClusters.length,
      clusters: formedClusters,
      similarityBasis,
    };
  }

  /**
   * Retrieves paginated candidates for a project, stripping sensitive CoT and internal tokens.
   */
  async getCandidates(
    projectId: number,
    options: {
      status?: string;
      clusterId?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ candidates: KnowledgeGapCandidateRecord[]; total: number }> {
    const conditions: string[] = ["project_id = $1"];
    const params: any[] = [projectId];
    let pIdx = 2;

    if (options.status) {
      conditions.push(`status = $${pIdx}`);
      params.push(options.status);
      pIdx++;
    }

    if (options.clusterId) {
      conditions.push(`cluster_id = $${pIdx}`);
      params.push(options.clusterId);
      pIdx++;
    }

    const countSql = `SELECT count(*)::integer AS total FROM knowledge_gap_candidates WHERE ${conditions.join(" AND ")};`;
    const countRes = await this.pool.query(countSql, params);
    const total = Number(countRes.rows[0]?.total || 0);

    const limit = Math.min(100, Math.max(1, Number(options.limit || 50)));
    const offset = Math.max(0, Number(options.offset || 0));

    const listSql = `
      SELECT *
      FROM knowledge_gap_candidates
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${pIdx} OFFSET $${pIdx + 1};
    `;
    params.push(limit, offset);

    const listRes = await this.pool.query(listSql, params);
    const candidates = listRes.rows.map((r: any) => this.mapCandidateRow(r));

    return { candidates, total };
  }

  /**
   * Retrieves aggregated clusters for a project.
   */
  async getClusters(
    projectId: number,
    options: { limit?: number; offset?: number } = {}
  ): Promise<{ clusters: any[]; total: number }> {
    const limit = Math.min(100, Math.max(1, Number(options.limit || 50)));
    const offset = Math.max(0, Number(options.offset || 0));

    const countSql = `
      SELECT count(DISTINCT cluster_id)::integer AS total
      FROM knowledge_gap_candidates
      WHERE project_id = $1 AND cluster_id IS NOT NULL;
    `;
    const countRes = await this.pool.query(countSql, [projectId]);
    const total = Number(countRes.rows[0]?.total || 0);

    const sql = `
      SELECT 
        kgc.cluster_id,
        count(*)::integer AS inquiry_count,
        count(DISTINCT COALESCE(c.identity_id::text, kgc.conversation_id::text, kgc.id::text))::integer AS unique_profiles_count,
        min(kgc.created_at) AS first_seen_at,
        max(kgc.created_at) AS last_seen_at,
        (array_agg(kgc.query_text ORDER BY kgc.score DESC))[1:5] AS sample_queries,
        array_agg(DISTINCT kgc.status) AS statuses
      FROM knowledge_gap_candidates kgc
      LEFT JOIN conversations c ON c.id = kgc.conversation_id
      WHERE kgc.project_id = $1 AND kgc.cluster_id IS NOT NULL
      GROUP BY kgc.cluster_id
      ORDER BY inquiry_count DESC
      LIMIT $2 OFFSET $3;
    `;

    const res = await this.pool.query(sql, [projectId, limit, offset]);

    const clusters = res.rows.map((r: any) => ({
      clusterId: r.cluster_id,
      topic: r.sample_queries?.[0] ? `Unanswered: ${r.sample_queries[0].slice(0, 80)}` : "Unanswered Topic",
      inquiryCount: Number(r.inquiry_count),
      uniqueProfilesCount: Number(r.unique_profiles_count),
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      sampleQueries: r.sample_queries || [],
      statuses: r.statuses || [],
    }));

    return { clusters, total };
  }

  /**
   * Maps raw database row to clean record, sanitizing evidence (stripping any internal model reasoning/CoT).
   */
  private mapCandidateRow(row: any): KnowledgeGapCandidateRecord {
    let evidence: KnowledgeGapEvidence = row.evidence;
    if (typeof evidence === "string") {
      try {
        evidence = JSON.parse(evidence);
      } catch {
        evidence = {} as any;
      }
    }

    // CoT & secret suppression safeguard: strip internal trace bodies, thoughts or keys
    if (evidence && evidence.signals) {
      for (const sig of Object.values(evidence.signals)) {
        if (sig && sig.details) {
          delete sig.details.rawPrompt;
          delete sig.details.reasoning;
          delete sig.details.chainOfThought;
          delete sig.details.apiKey;
        }
      }
    }

    return {
      id: Number(row.id),
      projectId: Number(row.project_id),
      conversationId: row.conversation_id !== null ? Number(row.conversation_id) : null,
      messageId: row.message_id !== null ? Number(row.message_id) : null,
      queryText: row.query_text,
      normalizedQuery: row.normalized_query,
      score: Number(row.score),
      evidence,
      status: row.status,
      clusterId: row.cluster_id || null,
      reviewNotes: row.review_notes || null,
      reviewedBy: row.reviewed_by || null,
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
      modelVersion: row.model_version || "v1",
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
    };
  }
}
