import { Conversation } from "../../../domain/entities/Conversation";

export class ConversationMapper {
  static toDomain(raw: any): Conversation {
    return new Conversation({
      id: String(raw.id),
      projectId: String(raw.project_id),
      identityId: String(raw.identity_id),
      status: raw.status,
      handledBy: raw.handled_by,
      channel: raw.channel || "WebChat",
      assignedPm: raw.assigned_pm || undefined,
      takeoverExpiresAt: null,
      createdAt: raw.created_at ? new Date(raw.created_at) : undefined,
      updatedAt: raw.updated_at ? new Date(raw.updated_at) : undefined
    });
  }

  static toPersistence(domain: Conversation): any {
    return {
      id: parseInt(domain.id),
      project_id: parseInt(domain.projectId),
      identity_id: parseInt(domain.identityId),
      status: domain.status,
      handled_by: domain.handledBy,
      channel: domain.channel,
      assigned_pm: domain.assignedPm || null,
      created_at: domain.createdAt ? domain.createdAt.toISOString() : null,
      updated_at: domain.updatedAt ? domain.updatedAt.toISOString() : null
    };
  }
}
