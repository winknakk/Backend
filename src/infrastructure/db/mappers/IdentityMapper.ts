import { Identity } from "../../../domain/entities/Identity";

export class IdentityMapper {
  static toDomain(raw: any): Identity {
    return new Identity({
      id: String(raw.id),
      profileId: String(raw.profile_id),
      channel: raw.channel,
      channelRef: raw.channel_ref,
      createdAt: raw.created_at ? new Date(raw.created_at) : undefined
    });
  }

  static toPersistence(domain: Identity): any {
    return {
      id: parseInt(domain.id),
      profile_id: parseInt(domain.profileId),
      channel: domain.channel,
      channel_ref: domain.channelRef,
      created_at: domain.createdAt ? domain.createdAt.toISOString() : null
    };
  }
}
