export type TenantContextSource = 'jwt' | 'api_key' | 'webhook' | 'header_override' | 'fallback';

export interface TenantContext {
  readonly orgId: string;
  readonly projectId: string;
  readonly source: TenantContextSource;
  readonly isFallback: boolean;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly correlationId: string;
  readonly timestamp: number;
  /**
   * Projects this request may read or write. `null` means unrestricted
   * (service callers and super_admin only).
   *
   * This is a hard boundary applied by the data layer in addition to whatever
   * the caller asked for. Filtering on a caller-supplied projectId alone is
   * not authorization: it lets any caller pick another tenant's data by
   * changing a number.
   */
  readonly allowedProjectIds: readonly number[] | null;
}

export const DEFAULT_TENANT_CONTEXT: TenantContext = Object.freeze({
  orgId: 'org_default',
  projectId: '1',
  source: 'fallback',
  isFallback: true,
  roles: ['admin'],
  permissions: ['*'],
  correlationId: 'fallback_init',
  timestamp: 0,
  allowedProjectIds: [],
});

export function createTenantContext(partial: Partial<TenantContext>): TenantContext {
  return Object.freeze({
    orgId: partial.orgId || DEFAULT_TENANT_CONTEXT.orgId,
    projectId: partial.projectId || DEFAULT_TENANT_CONTEXT.projectId,
    source: partial.source || DEFAULT_TENANT_CONTEXT.source,
    isFallback: partial.isFallback ?? DEFAULT_TENANT_CONTEXT.isFallback,
    roles: partial.roles ? Object.freeze([...partial.roles]) : DEFAULT_TENANT_CONTEXT.roles,
    permissions: partial.permissions ? Object.freeze([...partial.permissions]) : DEFAULT_TENANT_CONTEXT.permissions,
    correlationId: partial.correlationId || `corr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: partial.timestamp || Date.now(),
    allowedProjectIds:
      partial.allowedProjectIds === null
        ? null
        : partial.allowedProjectIds
          ? Object.freeze([...partial.allowedProjectIds])
          : DEFAULT_TENANT_CONTEXT.allowedProjectIds,
  });
}
