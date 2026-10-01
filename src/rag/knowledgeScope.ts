import { getOptionalRequestContext } from "../kernel/context/RequestContextHolder";

/**
 * Project/tenant scope for knowledge retrieval and ingestion.
 *
 * The trusted request context wins over caller-supplied filters. When neither
 * names a project the result is null and callers fail closed (no results, no
 * write). There is deliberately no default project: the previous fallback to
 * project "1" let any context-less caller read project 1's documents.
 *
 * Tenant keeps its historical "1" default because the project filter alone
 * already isolates documents; it is only narrowed further by tenant.
 */
export interface KnowledgeScope {
  projectId: string;
  tenantId: string;
}

export function resolveKnowledgeScope(filters?: { projectId?: string | number | null; tenantId?: string | number | null }): KnowledgeScope | null {
  const context = getOptionalRequestContext();
  const projectId = context?.projectId ?? filters?.projectId;
  if (projectId === undefined || projectId === null || String(projectId).trim() === "") return null;
  const tenantId = context?.tenantId ?? filters?.tenantId ?? "1";
  return { projectId: String(projectId), tenantId: String(tenantId) };
}
