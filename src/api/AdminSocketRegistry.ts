import { AuthPrincipal } from "../infrastructure/security/SessionTokenService";
import { createLogger } from "../observability/logger";

const logger = createLogger("admin-sockets");

interface AdminSocketEntry {
  principal: AuthPrincipal;
  /** Projects this socket may receive events for. null means every project. */
  projectIds: number[] | null;
}

/**
 * Tracks authenticated admin WebSocket connections and their tenant scope.
 *
 * Replaces a bare Map<socket, projectId> whose project value was recorded but
 * never consulted: every broadcast iterated the whole map and sent to all
 * sockets, so an event for one project reached operators of every other one.
 */
export class AdminSocketRegistry {
  private readonly sockets = new Map<any, AdminSocketEntry>();

  add(socket: any, entry: AdminSocketEntry): void {
    this.sockets.set(socket, entry);
  }

  remove(socket: any): void {
    this.sockets.delete(socket);
  }

  get size(): number {
    return this.sockets.size;
  }

  private canReceive(entry: AdminSocketEntry, projectId: number | null): boolean {
    if (entry.projectIds === null) return true;
    if (projectId === null) {
      // An event with no resolvable project can only go to unrestricted
      // sockets. Broadcasting it to everyone is how cross-tenant leaks happen.
      return false;
    }
    return entry.projectIds.includes(projectId);
  }

  /**
   * Delivers a payload only to sockets scoped to the event's project.
   * Returns the number of sockets that received it.
   */
  broadcastToProject(projectId: string | number | null | undefined, payload: string): number {
    const parsed = projectId === null || projectId === undefined || projectId === "" ? NaN : Number(projectId);
    const target = Number.isInteger(parsed) ? parsed : null;

    let delivered = 0;
    let skipped = 0;

    for (const [socket, entry] of this.sockets) {
      if (socket.readyState !== 1) continue;
      if (!this.canReceive(entry, target)) {
        skipped += 1;
        continue;
      }
      try {
        socket.send(payload);
        delivered += 1;
      } catch (err: any) {
        // A failed send must not abort delivery to the remaining sockets.
        logger.warn({ error: err.message }, "Failed to deliver admin socket payload");
      }
    }

    if (target === null && skipped > 0) {
      logger.warn(
        { skipped },
        "Admin event had no resolvable project; withheld from project-scoped sockets"
      );
    }

    return delivered;
  }
}

export const adminSocketRegistry = new AdminSocketRegistry();
