import { TakeoverState, RoomStatus } from "../schemas/aiops";
import { RedisTakeoverManager } from "../infrastructure/cache/RedisTakeoverManager";
import { config } from "../config/env";
import * as fs from "fs";
import * as path from "path";

export class TakeoverManager {
  private localStates = new Map<string, TakeoverState>();
  private filePath: string;
  private defaultLeaseDurationMs: number;
  private redisManager: RedisTakeoverManager | null = null;

  constructor(
    filePath = path.resolve(__dirname, "../../../data/takeover_states.json"),
    defaultLeaseDurationMs = 30000 // default 30 seconds
  ) {
    this.filePath = filePath;
    this.defaultLeaseDurationMs = defaultLeaseDurationMs;
    
    if (config.CACHE_PROVIDER === "redis") {
      this.redisManager = new RedisTakeoverManager();
    } else {
      this.loadState();
    }
  }

  /**
   * Retrieves the human takeover state for a conversation (Redis or file-backed fallback).
   */
  async getTakeoverState(conversationId: string): Promise<TakeoverState> {
    if (this.redisManager) {
      const lease = await this.redisManager.checkLeaseStatus(conversationId);
      if (lease.active) {
        const startedAt = lease.startedAt || Date.now();
        return {
          conversationId,
          status: lease.status || "ACTIVE_HUMAN",
          assignedHumanAgentId: lease.agentId,
          updatedAt: new Date().toISOString(),
          leaseExpiresAt: new Date(lease.expiresAt!).toISOString(),
          maxLeaseExpiresAt: lease.maxExpiresAt ? new Date(lease.maxExpiresAt).toISOString() : null,
          human_session_started_at: new Date(startedAt).toISOString(),
          human_session_expire_at: new Date(lease.expiresAt!).toISOString(),
          last_human_reply_at: lease.lastHumanReplyAt ? new Date(lease.lastHumanReplyAt).toISOString() : null,
        };
      }
      return {
        conversationId,
        status: "ACTIVE_AI",
        updatedAt: new Date().toISOString(),
      };
    }

    // Local file fallback
    this.checkLease(conversationId);
    let state = this.localStates.get(conversationId);
    if (!state) {
      state = {
        conversationId,
        status: "ACTIVE_AI",
        updatedAt: new Date().toISOString(),
      };
      this.localStates.set(conversationId, state);
    }
    return state;
  }

  /**
   * Sets/acquires/releases the human takeover lease state.
   */
  async setTakeoverState(
    conversationId: string,
    status: RoomStatus,
    assignedHumanAgentId?: string,
    leaseDurationMs?: number,
    isReply?: boolean,
    maxSessionDurationMs = config.HUMAN_MAX_SESSION_MINUTES * 60 * 1000
  ): Promise<TakeoverState> {
    const now = new Date();

    if (this.redisManager) {
      if (status !== "ACTIVE_AI") {
        const duration = leaseDurationMs !== undefined ? leaseDurationMs : this.defaultLeaseDurationMs;
        const lease = await this.redisManager.acquireLease(
          conversationId,
          assignedHumanAgentId || "human_agent",
          duration,
          status,
          isReply,
          maxSessionDurationMs
        );
        return {
          conversationId,
          status,
          assignedHumanAgentId,
          updatedAt: now.toISOString(),
          leaseExpiresAt: new Date(lease.expiresAt).toISOString(),
          maxLeaseExpiresAt: new Date(lease.maxExpiresAt).toISOString(),
          human_session_started_at: new Date(lease.startedAt).toISOString(),
          human_session_expire_at: new Date(lease.expiresAt).toISOString(),
          last_human_reply_at: lease.lastHumanReplyAt ? new Date(lease.lastHumanReplyAt).toISOString() : null,
        };
      } else {
        await this.redisManager.releaseLease(conversationId);
        return {
          conversationId,
          status: "ACTIVE_AI",
          updatedAt: now.toISOString(),
        };
      }
    }

    // Local file fallback
    const existing = this.localStates.get(conversationId);
    let leaseExpiresAt: string | undefined;
    let maxLeaseExpiresAt = existing?.maxLeaseExpiresAt || null;
    let human_session_started_at = existing?.human_session_started_at || null;
    let human_session_expire_at = existing?.human_session_expire_at || null;
    let last_human_reply_at = existing?.last_human_reply_at || null;

    if (status !== "ACTIVE_AI") {
      const duration = leaseDurationMs !== undefined ? leaseDurationMs : this.defaultLeaseDurationMs;
      const continuingActiveSession = status === "ACTIVE_HUMAN" && existing?.status === "ACTIVE_HUMAN";
      if (!continuingActiveSession || !human_session_started_at) {
        human_session_started_at = now.toISOString();
        maxLeaseExpiresAt = new Date(now.getTime() + maxSessionDurationMs).toISOString();
      }
      const hardExpiry = maxLeaseExpiresAt ? new Date(maxLeaseExpiresAt).getTime() : now.getTime() + maxSessionDurationMs;
      leaseExpiresAt = new Date(Math.min(now.getTime() + duration, hardExpiry)).toISOString();
      human_session_expire_at = leaseExpiresAt;

      if (isReply) {
        last_human_reply_at = now.toISOString();
      }
    } else {
      human_session_started_at = null;
      human_session_expire_at = null;
      last_human_reply_at = null;
      maxLeaseExpiresAt = null;
    }

    const state: TakeoverState = {
      conversationId,
      status,
      assignedHumanAgentId,
      updatedAt: now.toISOString(),
      leaseExpiresAt,
      maxLeaseExpiresAt,
      human_session_started_at,
      human_session_expire_at,
      last_human_reply_at,
    };

    this.localStates.set(conversationId, state);
    this.saveState();
    return state;
  }

  private checkLease(conversationId: string): void {
    const state = this.localStates.get(conversationId);
    if (state && state.status !== "ACTIVE_AI" && state.leaseExpiresAt) {
      const expiry = new Date(state.leaseExpiresAt).getTime();
      const now = Date.now();
      if (now > expiry) {
        state.status = "ACTIVE_AI";
        state.leaseExpiresAt = undefined;
        state.assignedHumanAgentId = undefined;
        state.human_session_started_at = null;
        state.human_session_expire_at = null;
        state.last_human_reply_at = null;
        state.maxLeaseExpiresAt = null;
        state.updatedAt = new Date().toISOString();
        this.localStates.set(conversationId, state);
        this.saveState();
      }
    }
  }

  private loadState(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        try {
          const parsed = JSON.parse(raw);
          for (const key of Object.keys(parsed)) {
            this.localStates.set(key, parsed[key]);
          }
        } catch (parseError) {
          const backupPath = `${this.filePath}.bak.${Date.now()}`;
          fs.renameSync(this.filePath, backupPath);
        }
      }
    } catch (e) {
      console.warn("[TakeoverManager] Failed to load takeover states:", e);
    }
  }

  private saveState(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data: Record<string, TakeoverState> = {};
      for (const [k, v] of this.localStates.entries()) {
        data[k] = v;
      }
      const raw = JSON.stringify(data, null, 2);
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, raw, "utf-8");
      fs.renameSync(tempPath, this.filePath);
    } catch (e) {
      console.error("[TakeoverManager] Failed to save takeover states:", e);
    }
  }

  /**
   * Disconnects any active Redis managers.
   */
  async disconnect(): Promise<void> {
    if (this.redisManager) {
      await this.redisManager.disconnect();
    }
  }
}
