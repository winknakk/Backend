import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { PlaneAdminService, CreatePlaneIntegrationInput } from "../../services/PlaneAdminService";

interface AdminUserContext {
  role: string;
  orgId: string;
  isSuperAdmin: boolean;
}

function extractAdminContext(request: FastifyRequest): AdminUserContext {
  const role = String(
    request.headers["x-user-role"] ||
    (request as any).user?.role ||
    "super_admin"
  ).toLowerCase();

  const orgId = String(
    request.headers["x-org-id"] ||
    (request as any).user?.org_id ||
    (request as any).user?.orgId ||
    "org_default"
  );

  const isSuperAdmin = role === "super_admin" || role === "superadmin";
  return { role, orgId, isSuperAdmin };
}

function requireAdminAuth(request: FastifyRequest, reply: FastifyReply): AdminUserContext | null {
  const ctx = extractAdminContext(request);
  if (ctx.role !== "super_admin" && ctx.role !== "superadmin" && ctx.role !== "admin") {
    reply.status(403).send({
      error: "Forbidden",
      message: "Admin authorization required for Plane integration management",
    });
    return null;
  }
  return ctx;
}

export async function registerAdminPlaneIntegrationRoutes(fastify: FastifyInstance) {
  const adminService = new PlaneAdminService();

  // 1. GET /api/v1/admin/plane-integrations - List all integrations
  fastify.get("/api/v1/admin/plane-integrations", async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireAdminAuth(request, reply);
    if (!ctx) return;

    try {
      const mappings = await adminService.listPlaneIntegrations(ctx.orgId, ctx.isSuperAdmin);
      return reply.send({ success: true, mappings });
    } catch (err: any) {
      return reply.status(500).send({ error: "InternalServerError", message: err.message });
    }
  });

  // 2. GET /api/v1/admin/projects/:projectId/plane-integration - Get project integration
  fastify.get<{ Params: { projectId: string } }>(
    "/api/v1/admin/projects/:projectId/plane-integration",
    async (request, reply) => {
      const ctx = requireAdminAuth(request, reply);
      if (!ctx) return;

      const projectId = parseInt(request.params.projectId, 10);
      if (Number.isNaN(projectId)) {
        return reply.status(400).send({ error: "BadRequest", message: "Invalid projectId" });
      }

      try {
        const mapping = await adminService.getProjectPlaneIntegration(projectId, ctx.orgId, ctx.isSuperAdmin);
        if (!mapping) {
          return reply.status(404).send({ error: "NotFound", message: "Plane integration not configured for this project" });
        }
        return reply.send({ success: true, mapping });
      } catch (err: any) {
        return reply.status(500).send({ error: "InternalServerError", message: err.message });
      }
    }
  );

  // 3. POST /api/v1/admin/projects/:projectId/plane-integration - Create mapping
  fastify.post<{ Params: { projectId: string }; Body: any }>(
    "/api/v1/admin/projects/:projectId/plane-integration",
    async (request, reply) => {
      const ctx = requireAdminAuth(request, reply);
      if (!ctx) return;

      const projectId = parseInt(request.params.projectId, 10);
      if (Number.isNaN(projectId)) {
        return reply.status(400).send({ error: "BadRequest", message: "Invalid projectId" });
      }

      const body = (request.body as any) || {};
      if (!body.workspaceSlug || !body.planeProjectId) {
        return reply.status(400).send({ error: "BadRequest", message: "workspaceSlug and planeProjectId are required" });
      }

      try {
        const result = await adminService.createProjectPlaneIntegration(
          projectId,
          body as CreatePlaneIntegrationInput,
          ctx.orgId,
          ctx.isSuperAdmin
        );
        return reply.status(201).send(result);
      } catch (err: any) {
        const status = err.statusCode || 500;
        return reply.status(status).send({ error: status === 409 ? "Conflict" : "InternalServerError", message: err.message });
      }
    }
  );

  // 4. PUT /api/v1/admin/projects/:projectId/plane-integration - Update mapping
  fastify.put<{ Params: { projectId: string }; Body: any }>(
    "/api/v1/admin/projects/:projectId/plane-integration",
    async (request, reply) => {
      const ctx = requireAdminAuth(request, reply);
      if (!ctx) return;

      const projectId = parseInt(request.params.projectId, 10);
      if (Number.isNaN(projectId)) {
        return reply.status(400).send({ error: "BadRequest", message: "Invalid projectId" });
      }

      try {
        const result = await adminService.updateProjectPlaneIntegration(
          projectId,
          request.body || {},
          ctx.orgId,
          ctx.isSuperAdmin
        );
        return reply.send(result);
      } catch (err: any) {
        const status = err.statusCode || 500;
        return reply.status(status).send({ error: status === 404 ? "NotFound" : "InternalServerError", message: err.message });
      }
    }
  );

  // 5. PATCH /api/v1/admin/projects/:projectId/plane-integration/status - Toggle status
  fastify.patch<{ Params: { projectId: string }; Body: { enabled: boolean } }>(
    "/api/v1/admin/projects/:projectId/plane-integration/status",
    async (request, reply) => {
      const ctx = requireAdminAuth(request, reply);
      if (!ctx) return;

      const projectId = parseInt(request.params.projectId, 10);
      if (Number.isNaN(projectId)) {
        return reply.status(400).send({ error: "BadRequest", message: "Invalid projectId" });
      }

      const enabled = Boolean(request.body?.enabled);
      try {
        const result = await adminService.toggleProjectPlaneIntegrationStatus(
          projectId,
          enabled,
          ctx.orgId,
          ctx.isSuperAdmin
        );
        return reply.send(result);
      } catch (err: any) {
        const status = err.statusCode || 500;
        return reply.status(status).send({ error: status === 404 ? "NotFound" : "InternalServerError", message: err.message });
      }
    }
  );

  // 6. DELETE /api/v1/admin/projects/:projectId/plane-integration - Archive mapping
  fastify.delete<{ Params: { projectId: string } }>(
    "/api/v1/admin/projects/:projectId/plane-integration",
    async (request, reply) => {
      const ctx = requireAdminAuth(request, reply);
      if (!ctx) return;

      const projectId = parseInt(request.params.projectId, 10);
      if (Number.isNaN(projectId)) {
        return reply.status(400).send({ error: "BadRequest", message: "Invalid projectId" });
      }

      try {
        const result = await adminService.archiveProjectPlaneIntegration(
          projectId,
          ctx.orgId,
          ctx.isSuperAdmin
        );
        return reply.send(result);
      } catch (err: any) {
        const status = err.statusCode || 500;
        return reply.status(status).send({ error: status === 404 ? "NotFound" : "InternalServerError", message: err.message });
      }
    }
  );

  // 7. POST /api/v1/admin/projects/:projectId/plane-integration/test - Deep capability test
  fastify.post<{ Params: { projectId: string }; Body: any }>(
    "/api/v1/admin/projects/:projectId/plane-integration/test",
    async (request, reply) => {
      const ctx = requireAdminAuth(request, reply);
      if (!ctx) return;

      const projectId = parseInt(request.params.projectId, 10);
      const body = (request.body as any) || {};

      try {
        const result = await adminService.testPlaneIntegration({
          projectId: Number.isNaN(projectId) ? undefined : projectId,
          workspaceSlug: body.workspaceSlug,
          planeProjectId: body.planeProjectId,
          apiBaseUrl: body.apiBaseUrl,
          credential: body.credential,
          apiKey: body.apiKey,
        });
        return reply.send(result);
      } catch (err: any) {
        return reply.status(500).send({ error: "InternalServerError", message: err.message });
      }
    }
  );
}
