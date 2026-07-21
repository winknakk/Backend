import { DatabaseAdapter } from "../adapters/types";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { createLogger } from "../observability/logger";
import { IssueSessionResolver } from "../runtime/IssueSessionResolver";

const logger = createLogger("RuntimeContextResolver");

export interface RuntimeContext {
  conversationId: number;
  identityId: number;
  projectId: number;
  workspaceId?: number;
  companyId?: number;
  handledBy: "ai" | "human";
  channel: string;
}

export class RuntimeContextResolver {
  constructor(private dbAdapter: DatabaseAdapter) {}

  /**
   * Resolves the complete RuntimeContext from a given conversation ID.
   */
  async resolveRuntimeContext(conversationId: string | number): Promise<RuntimeContext | null> {
    const parsedConvId = typeof conversationId === "string" ? parseInt(conversationId, 10) : conversationId;
    if (isNaN(parsedConvId) || parsedConvId <= 0) {
      return null;
    }

    // 1. Try resolving from request-scoped L1 cache inside active IssueSession
    const activeSession = IssueSessionResolver.current();
    if (activeSession) {
      const cached = activeSession.cache.get<RuntimeContext>(`runtime-context:${parsedConvId}`);
      if (cached) {
        return cached;
      }
    }

    try {
      const { rows } = await pool.query(
        `SELECT 
          c.id AS conversation_id,
          c.identity_id,
          c.project_id,
          c.handled_by,
          c.channel,
          p.company_id
         FROM conversations c
         LEFT JOIN identities i ON i.id = c.identity_id
         LEFT JOIN profiles prof ON prof.id = i.profile_id
         LEFT JOIN companies comp ON comp.id = prof.company_id
         LEFT JOIN projects p ON p.id = c.project_id
         WHERE c.id = $1
         LIMIT 1`,
        [parsedConvId]
      );

      if (rows.length === 0) return null;

      const row = rows[0];
      const context: RuntimeContext = {
        conversationId: row.conversation_id,
        identityId: row.identity_id ? parseInt(row.identity_id, 10) : 0,
        projectId: row.project_id ? parseInt(row.project_id, 10) : 1,
        companyId: row.company_id ? parseInt(row.company_id, 10) : undefined,
        handledBy: row.handled_by === "human" ? "human" : "ai",
        channel: row.channel || "LINE",
      };

      // 2. Cache resolved context back into request-scoped L1 cache
      if (activeSession) {
        activeSession.cache.set(`runtime-context:${parsedConvId}`, context);
      }

      return context;
    } catch (err: any) {
      logger.error({ conversationId, error: err.message }, "Failed to resolve runtime context from conversation");
      return null;
    }
  }

  async resolveConversation(conversationId: string | number): Promise<any | null> {
    return await this.resolveRuntimeContext(conversationId);
  }

  async resolveProject(conversationId: string | number): Promise<number | null> {
    const ctx = await this.resolveRuntimeContext(conversationId);
    return ctx ? ctx.projectId : null;
  }

  async resolveIdentity(conversationId: string | number): Promise<number | null> {
    const ctx = await this.resolveRuntimeContext(conversationId);
    return ctx ? ctx.identityId : null;
  }
}
