import { Profile } from "../../../domain/entities/Profile";

export class ProfileMapper {
  static toDomain(raw: any): Profile {
    return new Profile({
      id: String(raw.id),
      companyId: raw.company_id ? String(raw.company_id) : null,
      name: raw.name || null,
      createdAt: raw.created_at ? new Date(raw.created_at) : undefined
    });
  }

  static toPersistence(domain: Profile): any {
    return {
      id: parseInt(domain.id),
      company_id: domain.companyId ? parseInt(domain.companyId) : null,
      name: domain.name || null,
      created_at: domain.createdAt ? domain.createdAt.toISOString() : null
    };
  }
}
