import { Profile } from "../../../domain/entities/Profile";

export class ProfileMapper {
  static toDomain(raw: any): Profile {
    return new Profile({
      id: String(raw.id),
      companyId: raw.company_id ? String(raw.company_id) : null,
      name: raw.name || null,
      email: raw.email || null,
      phone: raw.phone || null,
      createdAt: raw.created_at ? new Date(raw.created_at) : undefined
    });
  }

  static toPersistence(domain: Profile): any {
    const numericId = parseInt(domain.id, 10);
    const numericCompanyId = domain.companyId ? parseInt(domain.companyId, 10) : null;
    return {
      id: !isNaN(numericId) ? numericId : 1,
      company_id: (numericCompanyId && !isNaN(numericCompanyId)) ? numericCompanyId : null,
      name: domain.name || null,
      email: domain.email || null,
      phone: domain.phone || null,
      created_at: domain.createdAt ? domain.createdAt.toISOString() : null
    };
  }
}
