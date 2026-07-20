import { CacheService } from "../cache/CacheService";
import { createLogger } from "../observability/logger";

const logger = createLogger("RedisSessionManager");

export interface GroupSessionState {
  sessionOwner: string;
  activeParticipants: string[];
  lastActivityAt: string;
  expireAt: string;
}

export class RedisSessionManager {
  private cache = CacheService.getInstance();
  private defaultTtl = 180; // 3 minutes

  private getSessionKey(conversationId: string): string {
    return `session:group:${conversationId}`;
  }

  async getSession(conversationId: string): Promise<GroupSessionState | null> {
    const key = this.getSessionKey(conversationId);
    return await this.cache.get<GroupSessionState>(key);
  }

  async createSession(conversationId: string, ownerId: string): Promise<GroupSessionState> {
    const key = this.getSessionKey(conversationId);
    const now = new Date().toISOString();
    const expireAt = new Date(Date.now() + this.defaultTtl * 1000).toISOString();
    
    const session: GroupSessionState = {
      sessionOwner: ownerId,
      activeParticipants: [ownerId],
      lastActivityAt: now,
      expireAt,
    };

    await this.cache.set(key, session, this.defaultTtl);
    logger.info({ conversationId, ownerId }, "Created active group session in Redis cache");
    return session;
  }

  async addParticipant(conversationId: string, participantId: string): Promise<GroupSessionState | null> {
    const key = this.getSessionKey(conversationId);
    const session = await this.getSession(conversationId);
    if (!session) return null;

    if (!session.activeParticipants.includes(participantId)) {
      session.activeParticipants.push(participantId);
    }
    session.lastActivityAt = new Date().toISOString();
    session.expireAt = new Date(Date.now() + this.defaultTtl * 1000).toISOString();

    await this.cache.set(key, session, this.defaultTtl);
    logger.info({ conversationId, participantId }, "Added participant to active group session");
    return session;
  }

  async isParticipant(conversationId: string, userId: string): Promise<boolean> {
    const session = await this.getSession(conversationId);
    if (!session) return false;
    return session.activeParticipants.includes(userId);
  }

  async refreshSession(conversationId: string): Promise<void> {
    const key = this.getSessionKey(conversationId);
    const session = await this.getSession(conversationId);
    if (session) {
      session.lastActivityAt = new Date().toISOString();
      session.expireAt = new Date(Date.now() + this.defaultTtl * 1000).toISOString();
      await this.cache.set(key, session, this.defaultTtl);
    }
  }

  async deleteSession(conversationId: string): Promise<void> {
    const key = this.getSessionKey(conversationId);
    await this.cache.delete(key);
    logger.info({ conversationId }, "Deleted active group session from Redis cache");
  }
}
