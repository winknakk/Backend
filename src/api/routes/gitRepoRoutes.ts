import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { PostgresGitRepository } from "../../infrastructure/db/PostgresGitRepository";
import { CreateGitRepoInputSchema, UpdateGitRepoInputSchema } from "../../domain/entities/GitRepositoryEntity";
import { GitSyncService, GitWebhookPayload } from "../../services/GitSyncService";
import { KnowledgeService } from "../../tools/search-project-docs/KnowledgeService";
import { SearchCodebaseInputSchema } from "../../tools/SearchCodebaseTool";

const gitRepoDb = new PostgresGitRepository();
const gitSyncService = new GitSyncService(gitRepoDb);

/**
 * Resolves the organization for this request from the authenticated principal.
 *
 * The x-org-id / x-company-id headers previously took precedence over the
 * authenticated context, so any caller could select another tenant simply by
 * setting a header. They are now only honoured for principals that are
 * genuinely unrestricted (super_admin, service), where choosing an
 * organization to act on is the legitimate use; for everyone else the header
 * is ignored and the principal's own organization is used.
 *
 * Returns null after sending a 401/403 when no organization can be resolved.
 */
function resolveTenantOrFailClosed(request: FastifyRequest, reply: FastifyReply): string | null {
  const ctxOrgId = (request.tenantContext?.orgId || "").trim();
  const isUnrestricted = request.tenantScope?.unrestricted === true || ctxOrgId === "org_all";

  if (isUnrestricted) {
    const headerOrgId = String(
      request.headers["x-org-id"] || request.headers["x-company-id"] || ""
    ).trim();
    if (headerOrgId) return headerOrgId;
    // No organization named: fall through to the project's own owner.
    return "org_all";
  }

  if (!ctxOrgId) {
    reply.status(401).send({
      error: "Unauthorized: Tenant context (orgId) is mandatory for Git repository management.",
      code: "TENANT_CONTEXT_MISSING",
    });
    return null;
  }

  return ctxOrgId;
}

/**
 * Validates that the requested projectId exists and belongs to the given orgId.
 */
async function assertProjectOwnership(projectId: number, orgId: string, reply: FastifyReply): Promise<boolean> {
  try {
    // "org_all" is the unrestricted sentinel: the caller may act on any
    // organization, so ownership is satisfied by the project existing.
    const { rows } =
      orgId === "org_all"
        ? await pool.query(`SELECT id FROM projects WHERE id = $1 LIMIT 1`, [projectId])
        : await pool.query(
            `SELECT id FROM projects WHERE id = $1 AND org_id = $2 LIMIT 1`,
            [projectId, orgId]
          );

    if (rows.length === 0) {
      reply.status(403).send({
        error: `Forbidden: Project #${projectId} does not exist or does not belong to organization '${orgId}'.`,
        code: "PROJECT_OWNERSHIP_VIOLATION",
      });
      return false;
    }
    return true;
  } catch {
    const { rows } = await pool.query(`SELECT id FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
    if (rows.length === 0) {
      reply.status(404).send({
        error: `Project #${projectId} not found.`,
        code: "PROJECT_NOT_FOUND",
      });
      return false;
    }
    return true;
  }
}

export async function registerGitRepositoryRoutes(fastify: FastifyInstance) {
  // 1. Create Git Repository Mapping
  fastify.post(
    "/api/v1/internal/projects/:projectId/git-repositories",
    async (request: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
      const orgId = resolveTenantOrFailClosed(request, reply);
      if (!orgId) return;

      const projectId = parseInt(request.params.projectId, 10);
      if (isNaN(projectId) || projectId <= 0) {
        return reply.status(400).send({ error: "Invalid projectId parameter", code: "INVALID_PROJECT_ID" });
      }

      const isOwner = await assertProjectOwnership(projectId, orgId, reply);
      if (!isOwner) return;

      try {
        const input = CreateGitRepoInputSchema.parse(request.body);
        const record = await gitRepoDb.createRepository(input, orgId, projectId);
        return reply.status(201).send({ success: true, data: record });
      } catch (err: any) {
        if (err instanceof z.ZodError) {
          return reply.status(400).send({ error: "Validation Error", details: err.issues });
        }
        return reply.status(400).send({ error: err.message || "Failed to create Git Repository" });
      }
    }
  );

  // 2. List Git Repositories for a Project
  fastify.get(
    "/api/v1/internal/projects/:projectId/git-repositories",
    async (request: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
      const orgId = resolveTenantOrFailClosed(request, reply);
      if (!orgId) return;

      const projectId = parseInt(request.params.projectId, 10);
      if (isNaN(projectId) || projectId <= 0) {
        return reply.status(400).send({ error: "Invalid projectId parameter", code: "INVALID_PROJECT_ID" });
      }

      const isOwner = await assertProjectOwnership(projectId, orgId, reply);
      if (!isOwner) return;

      const records = await gitRepoDb.listRepositories(orgId, projectId);
      return reply.status(200).send({ success: true, data: records });
    }
  );

  // 3. Update Git Repository Mapping
  fastify.patch(
    "/api/v1/internal/projects/:projectId/git-repositories/:repoId",
    async (request: FastifyRequest<{ Params: { projectId: string; repoId: string } }>, reply: FastifyReply) => {
      const orgId = resolveTenantOrFailClosed(request, reply);
      if (!orgId) return;

      const projectId = parseInt(request.params.projectId, 10);
      if (isNaN(projectId) || projectId <= 0) {
        return reply.status(400).send({ error: "Invalid projectId parameter", code: "INVALID_PROJECT_ID" });
      }

      const isOwner = await assertProjectOwnership(projectId, orgId, reply);
      if (!isOwner) return;

      try {
        const input = UpdateGitRepoInputSchema.parse(request.body);
        const updated = await gitRepoDb.updateRepository(request.params.repoId, input, orgId, projectId);

        if (!updated) {
          return reply.status(404).send({ error: "Git Repository not found or access denied", code: "NOT_FOUND" });
        }

        return reply.status(200).send({ success: true, data: updated });
      } catch (err: any) {
        if (err instanceof z.ZodError) {
          return reply.status(400).send({ error: "Validation Error", details: err.issues });
        }
        return reply.status(400).send({ error: err.message || "Failed to update Git Repository" });
      }
    }
  );

  // 4. Delete / Disconnect Git Repository
  fastify.delete(
    "/api/v1/internal/projects/:projectId/git-repositories/:repoId",
    async (request: FastifyRequest<{ Params: { projectId: string; repoId: string } }>, reply: FastifyReply) => {
      const orgId = resolveTenantOrFailClosed(request, reply);
      if (!orgId) return;

      const projectId = parseInt(request.params.projectId, 10);
      if (isNaN(projectId) || projectId <= 0) {
        return reply.status(400).send({ error: "Invalid projectId parameter", code: "INVALID_PROJECT_ID" });
      }

      const isOwner = await assertProjectOwnership(projectId, orgId, reply);
      if (!isOwner) return;

      const deleted = await gitRepoDb.deleteRepository(request.params.repoId, orgId, projectId);
      if (!deleted) {
        return reply.status(404).send({ error: "Git Repository not found or access denied", code: "NOT_FOUND" });
      }

      return reply.status(200).send({ success: true, message: "Repository disconnected successfully" });
    }
  );

  // 5. List Git Sync Logs for a Project
  fastify.get(
    "/api/v1/internal/projects/:projectId/git-sync-logs",
    async (request: FastifyRequest<{ Params: { projectId: string }; Querystring: { repoId?: string } }>, reply: FastifyReply) => {
      const orgId = resolveTenantOrFailClosed(request, reply);
      if (!orgId) return;

      const projectId = parseInt(request.params.projectId, 10);
      if (isNaN(projectId) || projectId <= 0) {
        return reply.status(400).send({ error: "Invalid projectId parameter", code: "INVALID_PROJECT_ID" });
      }

      const isOwner = await assertProjectOwnership(projectId, orgId, reply);
      if (!isOwner) return;

      const repoId = request.query?.repoId;
      if (!repoId) {
        return reply.status(400).send({ error: "repoId query parameter is required to view sync logs", code: "MISSING_REPO_ID" });
      }

      const logs = await gitRepoDb.listSyncLogs(repoId, orgId, projectId);
      return reply.status(200).send({ success: true, data: logs });
    }
  );

  // 6. Git Push Webhook Receiver
  fastify.post(
    "/api/v1/internal/knowledge/git-webhook",
    async (request: FastifyRequest<{ Querystring: { repoId?: string; orgId?: string; projectId?: string } }>, reply: FastifyReply) => {
      const repoIdParam = request.query?.repoId;
      const orgIdParam = request.query?.orgId;
      const projectIdParam = request.query?.projectId;

      if (!repoIdParam || !orgIdParam || !projectIdParam) {
        return reply.status(400).send({ error: "Missing required webhook parameters (repoId, orgId, projectId)", code: "MISSING_WEBHOOK_PARAMS" });
      }

      const projectId = parseInt(projectIdParam, 10);
      if (isNaN(projectId)) {
        return reply.status(400).send({ error: "Invalid projectId parameter", code: "INVALID_PROJECT_ID" });
      }

      // Verify repository exists under mapped tenant & project
      const repoRecord = await gitRepoDb.getRepositoryById(repoIdParam, orgIdParam, projectId);
      if (!repoRecord || !repoRecord.isActive) {
        return reply.status(404).send({ error: "Git Repository not found or inactive", code: "REPOSITORY_NOT_FOUND" });
      }

      // Signature Verification
      const sigHeader = (request.headers["x-hub-signature-256"] || request.headers["x-gitlab-token"] || request.headers["x-git-signature"]) as string | undefined;

      if (repoRecord.webhookSecretHash) {
        const rawBody = (request.raw as any).rawBody || JSON.stringify(request.body);
        const isValidSig = gitSyncService.verifyWebhookSignature(rawBody, sigHeader, repoRecord.webhookSecretHash);

        if (!isValidSig) {
          return reply.status(401).send({ error: "Invalid Git Webhook Signature", code: "INVALID_SIGNATURE" });
        }
      }

      try {
        const payload = request.body as GitWebhookPayload;
        const syncResult = await gitSyncService.processPushEvent(repoRecord.id, orgIdParam, projectId, payload);
        return reply.status(200).send({ success: true, data: syncResult });
      } catch (err: any) {
        return reply.status(500).send({ error: "Git Sync Failed", message: err.message });
      }
    }
  );

  // 7. REST Endpoint for Live Codebase Search
  fastify.post(
    "/api/v1/internal/knowledge/search-codebase",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const orgId = resolveTenantOrFailClosed(request, reply);
      if (!orgId) return;

      try {
        const input = SearchCodebaseInputSchema.parse(request.body);
        const projectId = parseInt(input.projectId, 10);

        if (isNaN(projectId)) {
          return reply.status(400).send({ error: "Invalid projectId", code: "INVALID_PROJECT_ID" });
        }

        const isOwner = await assertProjectOwnership(projectId, orgId, reply);
        if (!isOwner) return;

        const knowledgeService = new KnowledgeService({} as any);
        const evidence = await knowledgeService.searchCodebase(input.query, {
          orgId,
          projectId,
          path: input.path,
          language: input.language,
          symbolType: input.symbolType,
          limit: input.limit,
        });

        return reply.status(200).send({ success: true, data: { evidence } });
      } catch (err: any) {
        if (err instanceof z.ZodError) {
          return reply.status(400).send({ error: "Validation Error", details: err.issues });
        }
        return reply.status(400).send({ error: err.message || "Codebase search failed" });
      }
    }
  );
}
