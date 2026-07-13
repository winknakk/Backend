import { Conversation } from "../../domain/entities/Conversation";
import { CacheService } from "../../cache/CacheService";

/**
 * RedisActiveSessionCache caches session information in Redis
 * to bypass database lookups on conversation hot-paths.
 */
export class RedisActiveSessionCache {
  private cache: CacheService;

  constructor() {
    this.cache = CacheService.getInstance();
  }

  private getCacheKey(conversationId: string): string {
    return `active:session:${conversationId}`;
  }

  /**
   * Caches an active conversation session state.
   */
  public async setSession(conversation: Conversation): Promise<void> {
    const key = this.getCacheKey(conversation.id);
    const ttl = 15 * 60; // 15 minutes TTL in seconds
    const data = {
      id: conversation.id,
      projectId: conversation.projectId,
      identityId: conversation.identityId,
      status: conversation.status,
      handledBy: conversation.handledBy,
      assignedPm: conversation.assignedPm,
      takeoverExpiresAt: conversation.takeoverExpiresAt
        ? conversation.takeoverExpiresAt.toISOString()
        : null,
    };
    await this.cache.set(key, data, ttl);
  }

  /**
   * Retrieves a cached active conversation session.
   */
  public async getSession(conversationId: string): Promise<any | null> {
    const key = this.getCacheKey(conversationId);
    return await this.cache.get<any>(key);
  }

  /**
   * Invalidates the cache key for a conversation session.
   */
  public async invalidateSession(conversationId: string): Promise<void> {
    const key = this.getCacheKey(conversationId);
    await this.cache.delete(key);
  }
}
