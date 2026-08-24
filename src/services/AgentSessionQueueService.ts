import { randomUUID } from "crypto";
import { Pool, PoolClient } from "pg";
import { createLogger } from "../observability/logger";

const logger = createLogger("agent-session-queue");

export interface QueueItem {
  id: string;
  conversation_id: number;
  source_event_id: string | null;
  channel: string;
  sender_ref: string;
  destination: string | null;
  project_id: number | null;
  payload: Record<string, unknown>;
  status: "queued" | "processing" | "completed" | "failed" | "dead_letter";
  lease_token: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  error_detail: string | null;
  sequence_at: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface EnqueueInput {
  conversationId: number;
  sourceEventId?: string | null;
  channel?: string;
  senderRef: string;
  destination?: string | null;
  projectId?: number | null;
  payload: Record<string, unknown>;
  sequenceAt?: Date;
}

export interface EnqueueResult {
  enqueued: boolean;
  isDuplicate: boolean;
  item: QueueItem;
}

export interface QueueStatusSummary {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  deadLetter: number;
  activeConversationsWithLeases: number;
  oldestQueuedAgeMs: number | null;
}

export interface ExpiredLeaseRecoveryResult {
  recoveredCount: number;
  /** Conversations with a newly re-queued item. A worker must be dispatched for each. */
  conversationIds: number[];
}

export class AgentSessionQueueService {
  constructor(private readonly pool: Pool) {}

  /**
   * Enqueues an inbound message for a conversation.
   * If an item with the same source_event_id already exists for this conversation,
   * it is treated as a duplicate webhook delivery and ignored.
   */
  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const {
      conversationId,
      sourceEventId = null,
      channel = "line",
      senderRef,
      destination = null,
      projectId = null,
      payload,
      sequenceAt = new Date(),
    } = input;

    try {
      const res = await this.pool.query(
        `INSERT INTO agent_session_queue 
          (conversation_id, source_event_id, channel, sender_ref, destination, project_id, payload, sequence_at, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', NOW(), NOW())
         ON CONFLICT (conversation_id, source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING
         RETURNING *`,
        [
          conversationId,
          sourceEventId,
          channel,
          senderRef,
          destination,
          projectId,
          JSON.stringify(payload),
          sequenceAt.toISOString(),
        ]
      );

      if (res.rows.length > 0) {
        const item = res.rows[0] as QueueItem;
        logger.info(
          { queueItemId: item.id, conversationId, sourceEventId },
          "[agent-queue] Enqueued new message"
        );
        return { enqueued: true, isDuplicate: false, item };
      }

      // Conflict occurred: retrieve the existing row
      const existingRes = await this.pool.query(
        `SELECT * FROM agent_session_queue WHERE conversation_id = $1 AND source_event_id = $2 LIMIT 1`,
        [conversationId, sourceEventId]
      );
      const existingItem = existingRes.rows[0] as QueueItem;
      logger.warn(
        { queueItemId: existingItem?.id, conversationId, sourceEventId },
        "[agent-queue] Duplicate event detected — returning existing queue item"
      );
      return { enqueued: false, isDuplicate: true, item: existingItem };
    } catch (err: any) {
      logger.error(
        { error: err.message, conversationId, sourceEventId },
        "[agent-queue] Failed to enqueue message"
      );
      throw err;
    }
  }

  /**
   * Atomically claims the next oldest queued message for a conversation,
   * provided no active valid lease currently exists for this conversation.
   *
   * Returns the claimed QueueItem with leaseToken and leaseExpiresAt,
   * or null if the conversation is currently busy with an active lease or no queued messages exist.
   */
  async claimNext(conversationId: number, leaseDurationMs = 120000): Promise<QueueItem | null> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // A SELECT ... FOR UPDATE cannot lock a row that does not exist.  Create
      // the state row first so the first two webhook deliveries for a new
      // conversation cannot both observe an unlocked/non-existent state and
      // claim two different messages concurrently.
      await client.query(
        `INSERT INTO agent_session_state (conversation_id, last_active_at, updated_at)
         VALUES ($1, NOW(), NOW())
         ON CONFLICT (conversation_id) DO NOTHING`,
        [conversationId]
      );

      // 1. Check if conversation already has an active valid lease
      const stateRes = await client.query(
        `SELECT active_queue_item_id, lease_token, lease_expires_at 
         FROM agent_session_state 
         WHERE conversation_id = $1 
         FOR UPDATE`,
        [conversationId]
      );

      if (stateRes.rows.length > 0) {
        const state = stateRes.rows[0];
        if (state.active_queue_item_id && state.lease_expires_at && new Date(state.lease_expires_at) > new Date()) {
          // Busy: an active lease is currently running
          await client.query("COMMIT");
          logger.debug(
            { conversationId, activeQueueItemId: state.active_queue_item_id, leaseExpiresAt: state.lease_expires_at },
            "[agent-queue] Conversation currently busy with active lease"
          );
          return null;
        }
      }

      // 2. Select oldest queued item for this conversation
      const queueRes = await client.query(
        `SELECT * FROM agent_session_queue 
         WHERE conversation_id = $1 AND status = 'queued' 
         ORDER BY sequence_at ASC, id ASC 
         LIMIT 1 
         FOR UPDATE SKIP LOCKED`,
        [conversationId]
      );

      if (queueRes.rows.length === 0) {
        // No queued items; clear any stale state
        await client.query(
          `UPDATE agent_session_state 
           SET active_queue_item_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW() 
           WHERE conversation_id = $1`,
          [conversationId]
        );
        await client.query("COMMIT");
        return null;
      }

      const itemToClaim = queueRes.rows[0];
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);

      // 3. Update queue item status to processing
      const updatedQueueRes = await client.query(
        `UPDATE agent_session_queue 
         SET status = 'processing', 
             lease_token = $2, 
             lease_expires_at = $3, 
             attempt_count = attempt_count + 1, 
             updated_at = NOW() 
         WHERE id = $1 
         RETURNING *`,
        [itemToClaim.id, leaseToken, leaseExpiresAt.toISOString()]
      );

      // 4. Update or insert conversation session state
      await client.query(
        `INSERT INTO agent_session_state 
          (conversation_id, active_queue_item_id, lease_token, lease_expires_at, last_active_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (conversation_id) DO UPDATE SET
          active_queue_item_id = EXCLUDED.active_queue_item_id,
          lease_token = EXCLUDED.lease_token,
          lease_expires_at = EXCLUDED.lease_expires_at,
          last_active_at = NOW(),
          updated_at = NOW()`,
        [conversationId, itemToClaim.id, leaseToken, leaseExpiresAt.toISOString()]
      );

      await client.query("COMMIT");

      const claimedItem = updatedQueueRes.rows[0] as QueueItem;
      logger.info(
        { queueItemId: claimedItem.id, conversationId, leaseToken, attemptCount: claimedItem.attempt_count },
        "[agent-queue] Claimed lease for queue item"
      );
      return claimedItem;
    } catch (err: any) {
      await client.query("ROLLBACK");
      logger.error({ error: err.message, conversationId }, "[agent-queue] Failed to claim next item");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Completes the current queue item and atomically claims the next queued item (if any)
   * for the conversation in a single transaction.
   *
   * If there are no more queued items, clears the active conversation lease.
   */
  async completeAndClaimNext(
    conversationId: number,
    currentItemId: string | number,
    leaseToken: string,
    leaseDurationMs = 120000
  ): Promise<QueueItem | null> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const stateRes = await client.query(
        `SELECT active_queue_item_id, lease_token
         FROM agent_session_state
         WHERE conversation_id = $1
         FOR UPDATE`,
        [conversationId]
      );

      const state = stateRes.rows[0];
      if (!state || String(state.active_queue_item_id) !== String(currentItemId) || state.lease_token !== leaseToken) {
        logger.warn(
          { currentItemId, conversationId },
          "[agent-queue] completeAndClaimNext: active lease no longer belongs to this worker"
        );
        await client.query("ROLLBACK");
        return null;
      }

      // 1. Mark current item completed (validating lease token)
      const completeRes = await client.query(
        `UPDATE agent_session_queue 
         SET status = 'completed', 
             completed_at = NOW(), 
             updated_at = NOW() 
         WHERE id = $1 AND lease_token = $2 
         RETURNING id`,
        [currentItemId, leaseToken]
      );

      if (completeRes.rows.length === 0) {
        logger.warn(
          { currentItemId, leaseToken, conversationId },
          "[agent-queue] completeAndClaimNext: Lease token mismatch or item not found"
        );
        await client.query("ROLLBACK");
        return null;
      }

      logger.info(
        { currentItemId, conversationId },
        "[agent-queue] Completed queue item turn"
      );

      // 2. Select next queued item for this conversation
      const nextQueueRes = await client.query(
        `SELECT * FROM agent_session_queue 
         WHERE conversation_id = $1 AND status = 'queued' 
         ORDER BY sequence_at ASC, id ASC 
         LIMIT 1 
         FOR UPDATE SKIP LOCKED`,
        [conversationId]
      );

      if (nextQueueRes.rows.length === 0) {
        // Queue is empty for this conversation: release active lease
        await client.query(
          `UPDATE agent_session_state 
           SET active_queue_item_id = NULL, 
               lease_token = NULL, 
               lease_expires_at = NULL, 
               last_active_at = NOW(), 
               updated_at = NOW() 
           WHERE conversation_id = $1`,
          [conversationId]
        );
        await client.query("COMMIT");
        logger.debug({ conversationId }, "[agent-queue] Queue is now empty for conversation; lease released");
        return null;
      }

      // 3. Next item exists: claim it atomically
      const nextItem = nextQueueRes.rows[0];
      const nextLeaseToken = randomUUID();
      const nextLeaseExpiresAt = new Date(Date.now() + leaseDurationMs);

      const updatedNextRes = await client.query(
        `UPDATE agent_session_queue 
         SET status = 'processing', 
             lease_token = $2, 
             lease_expires_at = $3, 
             attempt_count = attempt_count + 1, 
             updated_at = NOW() 
         WHERE id = $1 
         RETURNING *`,
        [nextItem.id, nextLeaseToken, nextLeaseExpiresAt.toISOString()]
      );

      await client.query(
        `UPDATE agent_session_state 
         SET active_queue_item_id = $2, 
             lease_token = $3, 
             lease_expires_at = $4, 
             last_active_at = NOW(), 
             updated_at = NOW() 
         WHERE conversation_id = $1`,
        [conversationId, nextItem.id, nextLeaseToken, nextLeaseExpiresAt.toISOString()]
      );

      await client.query("COMMIT");

      const claimedNext = updatedNextRes.rows[0] as QueueItem;
      logger.info(
        { queueItemId: claimedNext.id, conversationId, nextLeaseToken },
        "[agent-queue] Atomically claimed next item in queue"
      );
      return claimedNext;
    } catch (err: any) {
      await client.query("ROLLBACK");
      logger.error(
        { error: err.message, currentItemId, conversationId },
        "[agent-queue] Failed to completeAndClaimNext"
      );
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Marks the current queue item as failed (or dead_letter if max attempts reached)
   * and releases the active lease so subsequent messages in the conversation can proceed.
   */
  async failAndRelease(
    conversationId: number,
    currentItemId: string | number,
    leaseToken: string,
    errorDetail: string,
    maxAttempts = 2
  ): Promise<void> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const stateRes = await client.query(
        `SELECT active_queue_item_id, lease_token
         FROM agent_session_state
         WHERE conversation_id = $1
         FOR UPDATE`,
        [conversationId]
      );
      const state = stateRes.rows[0];
      if (!state || String(state.active_queue_item_id) !== String(currentItemId) || state.lease_token !== leaseToken) {
        logger.warn(
          { currentItemId, conversationId },
          "[agent-queue] failAndRelease: active lease no longer belongs to this worker"
        );
        await client.query("ROLLBACK");
        return;
      }

      const itemRes = await client.query(
        `SELECT attempt_count FROM agent_session_queue WHERE id = $1`,
        [currentItemId]
      );
      const attemptCount = itemRes.rows[0]?.attempt_count || 1;
      const nextStatus = attemptCount >= maxAttempts ? "dead_letter" : "failed";

      await client.query(
        `UPDATE agent_session_queue 
         SET status = $2, 
             error_detail = $3, 
             updated_at = NOW() 
         WHERE id = $1 AND (lease_token = $4 OR lease_token IS NULL)`,
        [currentItemId, nextStatus, errorDetail, leaseToken]
      );

      // Release active lease on state
      await client.query(
        `UPDATE agent_session_state 
         SET active_queue_item_id = NULL, 
             lease_token = NULL, 
             lease_expires_at = NULL, 
             last_active_at = NOW(), 
             updated_at = NOW() 
         WHERE conversation_id = $1`,
        [conversationId]
      );

      await client.query("COMMIT");
      logger.warn(
        { currentItemId, conversationId, nextStatus, attemptCount, errorDetail },
        "[agent-queue] Item marked failed/dead_letter and lease released"
      );
    } catch (err: any) {
      await client.query("ROLLBACK");
      logger.error(
        { error: err.message, currentItemId, conversationId },
        "[agent-queue] Failed to failAndRelease"
      );
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Recovers expired leases (e.g. from server restart or crashed worker).
   * Re-queues eligible items for retry if attempt_count < maxAttempts,
   * otherwise moves them to dead_letter.
   */
  async recoverExpiredLeases(maxAttempts = 2): Promise<ExpiredLeaseRecoveryResult> {
    try {
      // 1. Move expired items with >= maxAttempts to dead_letter
      const deadLetterRes = await this.pool.query(
        `UPDATE agent_session_queue 
         SET status = 'dead_letter', 
             error_detail = COALESCE(error_detail, 'Lease expired and exceeded max attempts'), 
             updated_at = NOW() 
         WHERE status = 'processing' 
           AND lease_expires_at <= NOW() 
           AND attempt_count >= $1 
         RETURNING id`,
        [maxAttempts]
      );

      // 2. Re-queue expired items that still have retry attempts remaining
      const requeueRes = await this.pool.query(
        `UPDATE agent_session_queue 
         SET status = 'queued', 
             lease_token = NULL, 
             lease_expires_at = NULL, 
             updated_at = NOW() 
         WHERE status = 'processing' 
           AND lease_expires_at <= NOW() 
           AND attempt_count < $1 
         RETURNING id, conversation_id`,
        [maxAttempts]
      );

      // 3. Clear expired leases from state table
      await this.pool.query(
        `UPDATE agent_session_state 
         SET active_queue_item_id = NULL, 
             lease_token = NULL, 
             lease_expires_at = NULL, 
             updated_at = NOW() 
         WHERE lease_expires_at <= NOW()`
      );

      const totalRecovered = deadLetterRes.rows.length + requeueRes.rows.length;
      if (totalRecovered > 0) {
        logger.info(
          {
            deadLetterCount: deadLetterRes.rows.length,
            requeuedCount: requeueRes.rows.length,
            totalRecovered,
          },
          "[agent-queue] Recovered expired leases"
        );
      }

      return {
        recoveredCount: totalRecovered,
        conversationIds: [...new Set(requeueRes.rows.map((row) => Number(row.conversation_id)))],
      };
    } catch (err: any) {
      logger.error({ error: err.message }, "[agent-queue] Failed to recover expired leases");
      return { recoveredCount: 0, conversationIds: [] };
    }
  }

  /**
   * Returns aggregate queue metrics and oldest queued age for observability.
   */
  async getQueueStatus(): Promise<QueueStatusSummary> {
    const countsRes = await this.pool.query(
      `SELECT status, COUNT(*)::integer AS count 
       FROM agent_session_queue 
       GROUP BY status`
    );

    const counts: Record<string, number> = {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      dead_letter: 0,
    };

    for (const row of countsRes.rows) {
      counts[row.status] = Number(row.count);
    }

    const stateRes = await this.pool.query(
      `SELECT COUNT(*)::integer AS count 
       FROM agent_session_state 
       WHERE active_queue_item_id IS NOT NULL AND lease_expires_at > NOW()`
    );
    const activeLeases = Number(stateRes.rows[0]?.count || 0);

    const oldestRes = await this.pool.query(
      `SELECT sequence_at 
       FROM agent_session_queue 
       WHERE status = 'queued' 
       ORDER BY sequence_at ASC 
       LIMIT 1`
    );

    let oldestQueuedAgeMs: number | null = null;
    if (oldestRes.rows.length > 0 && oldestRes.rows[0].sequence_at) {
      oldestQueuedAgeMs = Date.now() - new Date(oldestRes.rows[0].sequence_at).getTime();
    }

    return {
      queued: counts.queued || 0,
      processing: counts.processing || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      deadLetter: counts.dead_letter || 0,
      activeConversationsWithLeases: activeLeases,
      oldestQueuedAgeMs,
    };
  }

  /**
   * Lists items in queue with optional filtering for admin diagnostics.
   */
  async getQueueItems(filter: {
    conversationId?: number;
    status?: string;
    limit?: number;
  }): Promise<QueueItem[]> {
    const conditions: string[] = [];
    const args: any[] = [];
    let idx = 1;

    if (filter.conversationId) {
      conditions.push(`conversation_id = $${idx++}`);
      args.push(filter.conversationId);
    }

    if (filter.status) {
      conditions.push(`status = $${idx++}`);
      args.push(filter.status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(filter.limit || 50, 200);
    args.push(limit);

    const res = await this.pool.query(
      `SELECT * FROM agent_session_queue 
       ${whereClause} 
       ORDER BY id DESC 
       LIMIT $${idx}`,
      args
    );

    return res.rows as QueueItem[];
  }
}
