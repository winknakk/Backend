import { FastifyInstance } from "fastify";
import { z } from "zod";

const LoginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export async function registerAuthRoutes(fastify: FastifyInstance) {
  fastify.post("/api/v1/auth/login", async (request, reply) => {
    const parseResult = LoginSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: "Invalid login payload" });
    }

    const { username, password } = parseResult.data;

    // Validate admin credentials (admin / admin123 or ENV override)
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
          role: "Admin",
          email: "admin@ticketx.ai",
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
        role: "Admin",
        email: "admin@ticketx.ai",
      },
    });
  });
}
