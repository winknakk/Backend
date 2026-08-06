import { FastifyInstance } from "fastify";
import { z } from "zod";

import { CentralAuthService } from "../../services/CentralAuthService";

const LoginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

const CenterTokenSchema = z.object({
  token: z.string(),
});

export async function registerAuthRoutes(fastify: FastifyInstance) {
  const centralAuthService = new CentralAuthService();

  // 1. Center Login Proxy
  fastify.post("/api/v1/auth/center-login", async (request, reply) => {
    const parseResult = LoginSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: "Invalid login payload" });
    }

    const { username, password } = parseResult.data;

    try {
      const centerRes = await centralAuthService.loginToCenter(username, password);
      const token = centerRes.token || centerRes.access_token || "";
      const profile = centralAuthService.parseCenterJwt(token);

      return reply.send({
        success: true,
        token: centerRes.token || centerRes.access_token,
        profile,
        centerResponse: centerRes,
      });
    } catch (err: any) {
      return reply.status(401).send({ error: "Center Authentication Failed", message: err.message });
    }
  });

  // 2. Parse existing Center JWT token
  fastify.post("/api/v1/auth/parse-center-token", async (request, reply) => {
    const body = CenterTokenSchema.parse(request.body);
    const profile = centralAuthService.parseCenterJwt(body.token);

    return reply.send({
      success: true,
      profile,
    });
  });

  // 3. Fallback Local Login
  fastify.post("/api/v1/auth/login", async (request, reply) => {
    const parseResult = LoginSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: "Invalid login payload" });
    }

    const { username, password } = parseResult.data;

    // Direct Center Auth check if email is provided
    if (username.includes("@")) {
      try {
        const centerRes = await centralAuthService.loginToCenter(username, password);
        const token = centerRes.token || centerRes.access_token || "";
        const profile = centralAuthService.parseCenterJwt(token);
        return reply.send({
          success: true,
          token,
          user: profile,
        });
      } catch (e) {
        // Fallback to local admin
      }
    }

    const validUsername = process.env.ADMIN_USERNAME || "admin";
    const validPassword = process.env.ADMIN_PASSWORD || "admin123";

    if (username === validUsername && password === validPassword) {
      const token = `ticketx_admin_token_${Date.now()}`;
      return reply.send({
        success: true,
        token,
        user: {
          username,
          name: "Admin Operator",
          role: "super_admin",
          email: "admin@ticketx.ai",
          orgId: "org_default",
        },
      });
    }

    return reply.status(401).send({ error: "Invalid username or password" });
  });

  fastify.get("/api/v1/auth/me", async (request, reply) => {
    return reply.send({
      authenticated: true,
      user: {
        username: "admin",
        name: "Admin Operator",
        role: "super_admin",
        email: "admin@ticketx.ai",
        orgId: "org_default",
      },
    });
  });
}
