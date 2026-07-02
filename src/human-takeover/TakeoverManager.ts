import * as fs from "fs";
import * as path from "path";
import { TakeoverState, RoomStatus } from "../schemas/aiops";

export class TakeoverManager {
  private states = new Map<string, TakeoverState>();
  private filePath: string;
  private defaultLeaseDurationMs: number;

  constructor(
    filePath = path.resolve(__dirname, "../../../data/takeover_states.json"),
    defaultLeaseDurationMs = 30000 // default 30 seconds
  ) {
    this.filePath = filePath;
    this.defaultLeaseDurationMs = defaultLeaseDurationMs;
    this.loadState();
  }

  getTakeoverState(conversationId: string): TakeoverState {
    this.checkLease(conversationId);
    let state = this.states.get(conversationId);
    if (!state) {
      state = {
        conversationId,
        status: "ACTIVE_AI",
        updatedAt: new Date().toISOString(),
      };
      this.states.set(conversationId, state);
    }
    return state;
  }

  setTakeoverState(
    conversationId: string,
    status: RoomStatus,
    assignedHumanAgentId?: string,
    leaseDurationMs?: number,
    isReply?: boolean
  ): TakeoverState {
    const now = new Date();
    const existing = this.states.get(conversationId);

    let leaseExpiresAt: string | undefined;
    let human_session_started_at = existing?.human_session_started_at || null;
    let human_session_expire_at = existing?.human_session_expire_at || null;
    let last_human_reply_at = existing?.last_human_reply_at || null;

    if (status !== "ACTIVE_AI") {
      const duration = leaseDurationMs !== undefined ? leaseDurationMs : this.defaultLeaseDurationMs;
      leaseExpiresAt = new Date(now.getTime() + duration).toISOString();
      
      if (!human_session_started_at) {
        human_session_started_at = now.toISOString();
      }
      human_session_expire_at = leaseExpiresAt;

      if (isReply) {
        last_human_reply_at = now.toISOString();
      }
    } else {
      human_session_started_at = null;
      human_session_expire_at = null;
      last_human_reply_at = null;
    }

    const state: TakeoverState = {
      conversationId,
      status,
      assignedHumanAgentId,
      updatedAt: now.toISOString(),
      leaseExpiresAt,
      human_session_started_at,
      human_session_expire_at,
      last_human_reply_at,
    };

    this.states.set(conversationId, state);
    this.saveState();
    return state;
  }

  // Check and revert state if lease expired
  private checkLease(conversationId: string): void {
    const state = this.states.get(conversationId);
    if (state && state.status !== "ACTIVE_AI" && state.leaseExpiresAt) {
      const expiry = new Date(state.leaseExpiresAt).getTime();
      const now = Date.now();
      if (now > expiry) {
        // Lease expired, revert to AI
        state.status = "ACTIVE_AI";
        state.leaseExpiresAt = undefined;
        state.assignedHumanAgentId = undefined;
        state.human_session_started_at = null;
        state.human_session_expire_at = null;
        state.last_human_reply_at = null;
        state.updatedAt = new Date().toISOString();
        this.states.set(conversationId, state);
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
            this.states.set(key, parsed[key]);
          }
        } catch (parseError) {
          console.error("[TakeoverManager] Corrupted takeover state file, backing up and starting fresh:", parseError);
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
      for (const [k, v] of this.states.entries()) {
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
}
