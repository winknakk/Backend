import { WebChatSession } from "../../../domain/entities/WebChatSession";

export class WebChatSessionMapper {
  static toDomain(raw: any): WebChatSession {
    return new WebChatSession({
      id: String(raw.id),
      identityId: String(raw.identity_id),
      sessionToken: raw.session_token,
      createdAt: raw.created_at ? new Date(raw.created_at) : undefined,
      lastActiveAt: raw.last_active_at ? new Date(raw.last_active_at) : undefined
    });
  }

  static toPersistence(domain: WebChatSession): any {
    return {
      id: parseInt(domain.id),
      identity_id: parseInt(domain.identityId),
      session_token: domain.sessionToken,
      created_at: domain.createdAt ? domain.createdAt.toISOString() : null,
      last_active_at: domain.lastActiveAt ? domain.lastActiveAt.toISOString() : null
    };
  }
}
