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
    leaseDurationMs?: number
  ): TakeoverState {
    const now = new Date();
    let leaseExpiresAt: string | undefined;

    if (status !== "ACTIVE_AI") {
      const duration = leaseDurationMs !== undefined ? leaseDurationMs : this.defaultLeaseDurationMs;
      leaseExpiresAt = new Date(now.getTime() + duration).toISOString();
    }

    const state: TakeoverState = {
      conversationId,
      status,
      assignedHumanAgentId,
      updatedAt: now.toISOString(),
      leaseExpiresAt,
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
        const parsed = JSON.parse(raw);
        for (const key of Object.keys(parsed)) {
          this.states.set(key, parsed[key]);
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
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      console.warn("[TakeoverManager] Failed to save takeover states:", e);
    }
  }
}
