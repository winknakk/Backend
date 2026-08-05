import { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { TenantContext, DEFAULT_TENANT_CONTEXT } from "../../domain/tenant/TenantContext";
import { TenantResolver } from "../../infrastructure/security/TenantResolver";

declare module "fastify" {
  interface FastifyRequest {
    tenantContext: TenantContext;
  }
}

const tenantResolver = new TenantResolver();

const tenantPluginAsync: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.decorateRequest("tenantContext", {
    getter(this: FastifyRequest) {
      return (this as any)._tenantContext || DEFAULT_TENANT_CONTEXT;
    },
    setter(this: FastifyRequest, val: TenantContext) {
      (this as any)._tenantContext = val;
    },
  });

  fastify.addHook("onRequest", async (request: FastifyRequest) => {
    const resolvedContext = tenantResolver.resolve(request);
    request.tenantContext = resolvedContext;
  });
};

export const tenantPlugin = fp(tenantPluginAsync, {
  name: "tenant-plugin",
  fastify: ">=4.x",
});
