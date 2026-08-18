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

const CenterOrgReqSchema = z.object({
  token: z.string(),
  orgId: z.string(),
});

const CompleteCenterLoginSchema = z.object({
  token: z.string(),
  orgId: z.string().optional(),
});

const AddCenterRoleSchema = z.object({
  token: z.string(),
  orgId: z.string(),
  email: z.string(),
  firstname: z.string(),
  lastname: z.string(),
  username: z.string().optional(),
  type: z.string().default("user"),
  head: z.string().optional(),
  position_name: z.string().optional(),
});

const CreateCenterOrgSchema = z.object({
  token: z.string(),
  org_name: z.string(),
  description: z.string().optional(),
  org_department_code: z.string().optional(),
  app_id: z.string().optional(),
  initialManager: z
    .object({
      email: z.string(),
      firstname: z.string().optional(),
      lastname: z.string().optional(),
      position_name: z.string().optional(),
    })
    .optional(),
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
      const idToken = centerRes.IDToken || centerRes.id_token || "";
      const profile = centralAuthService.parseCenterJwt(token, idToken);

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

  // 3. Find Orgs By User (Center CM Service)
  fastify.post("/api/v1/auth/center/find-orgs", async (request, reply) => {
    try {
      const body = CenterTokenSchema.parse(request.body);
      const orgs = await centralAuthService.findOrgsByUser(body.token);
      return reply.send({ success: true, orgs });
    } catch (err: any) {
      const msg = err.message || '';
      const isAuthError = msg.includes("401") || msg.includes("403") || msg.includes("Unauthorized") || msg.includes("status: 401") || msg.includes("status: 403");
      return reply.send({
        success: false,
        error: isAuthError
          ? "Center session token expired or unauthorized. Please update your token or re-login."
          : (msg || "Failed to fetch Center organizations"),
        isAuthError,
      });
    }
  });

  // 4. Get My Role (Center CM Service)
  fastify.post("/api/v1/auth/center/get-my-role", async (request, reply) => {
    try {
      const body = CenterOrgReqSchema.parse(request.body);
      const role = await centralAuthService.getMyRole(body.token, body.orgId);
      return reply.send({ success: true, role });
    } catch (err: any) {
      const msg = err.message || '';
      const isAuthError = msg.includes("401") || msg.includes("403") || msg.includes("Unauthorized") || msg.includes("status: 401") || msg.includes("status: 403");
      return reply.send({
        success: false,
        error: isAuthError
          ? "Center session token expired or unauthorized. Please update your token."
          : (msg || "Failed to fetch role from Center"),
        isAuthError,
      });
    }
  });

  // 5. Get User Roles in Org (Center CM Service)
  fastify.post("/api/v1/auth/center/get-user-roles", async (request, reply) => {
    try {
      const body = CenterOrgReqSchema.parse(request.body);
      const roles = await centralAuthService.getUserRoles(body.token, body.orgId);
      return reply.send({ success: true, roles });
    } catch (err: any) {
      const msg = err.message || '';
      const isAuthError = msg.includes("401") || msg.includes("403") || msg.includes("Unauthorized") || msg.includes("status: 401") || msg.includes("status: 403");
      return reply.send({
        success: false,
        error: isAuthError
          ? "Center session token expired or unauthorized. Please update your token."
          : (msg || "Failed to fetch user roles from Center"),
        isAuthError,
      });
    }
  });

  // 6. Add / Assign Role on Center CM Service
  fastify.post("/api/v1/auth/center/add-role", async (request, reply) => {
    try {
      const body = AddCenterRoleSchema.parse(request.body);
      const result = await centralAuthService.addRoleToCenter(body.token, body);
      return reply.send(result);
    } catch (err: any) {
      const isAuthError = err.message?.includes("401") || err.message?.includes("Unauthorized");
      return reply.send({
        success: false,
        error: err.message || "Failed to add role on Center CM Service",
        isAuthError,
      });
    }
  });

  // 7. Create New Organization on Center CM Service
  fastify.post("/api/v1/auth/center/create-org", async (request, reply) => {
    try {
      const body = CreateCenterOrgSchema.parse(request.body);
      const result = await centralAuthService.createOrgOnCenter(body.token, body);
      return reply.send(result);
    } catch (err: any) {
      const isAuthError = err.message?.includes("401") || err.message?.includes("Unauthorized");
      return reply.send({
        success: false,
        error: err.message || "Failed to create organization on Center CM Service",
        isAuthError,
      });
    }
  });

  // 6. Complete Center Login (Token + Org & Role Resolution)
  fastify.post("/api/v1/auth/center/complete-login", async (request, reply) => {
    try {
      const body = CompleteCenterLoginSchema.parse(request.body);
      const { token } = body;
      const idToken = (request.body as any)?.idToken || (request.body as any)?.IDToken || "";
      const profile = centralAuthService.parseCenterJwt(token, idToken);

      // Attempt to resolve orgId if not provided
      let effectiveOrgId = body.orgId || profile.orgId;
      let userOrgs: any[] = [];
      try {
        userOrgs = await centralAuthService.findOrgsByUser(token);
        if (!body.orgId && userOrgs.length > 0 && userOrgs[0].id) {
          effectiveOrgId = userOrgs[0].id;
        }
      } catch (e) {
        // Fallback to parsed orgId from JWT
      }

      // Attempt to fetch My Role from Center CM Service
      let myRole = null;
      if (effectiveOrgId) {
        try {
          myRole = await centralAuthService.getMyRole(token, effectiveOrgId);
          if (myRole) {
            profile.firstname = myRole.firstname || profile.firstname;
            profile.lastname = myRole.lastname || profile.lastname;
            profile.iam2_id = myRole.iam2_id;
            profile.position_name = myRole.position_name;
            profile.type = myRole.type;
            if (myRole.firstname || myRole.lastname) {
              profile.name = `${myRole.firstname} ${myRole.lastname}`.trim();
            }
          }
        } catch (e) {
          // Non-blocking fallback
        }
      }

      profile.orgId = effectiveOrgId;

      return reply.send({
        success: true,
        token,
        profile,
        orgs: userOrgs,
        myRole,
      });
    } catch (err: any) {
      return reply.status(401).send({ error: "Center Login Completion Failed", message: err.message });
    }
  });

  // 7. Fallback Local Login
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
        // Fallback to local accounts
      }
    }

    // Quick Mock Demo Accounts
    const mockAccounts: Record<string, { name: string; role: "super_admin" | "admin" | "employee" | "customer"; orgId: string }> = {
      "superadmin@ticketx.io": { name: "Super Admin Overseer", role: "super_admin", orgId: "org_default" },
      "admin@avalant.co.th": { name: "Avalant Org Admin", role: "admin", orgId: "org_avalant" },
      "agent@avalant.co.th": { name: "Avalant Support Agent", role: "employee", orgId: "org_avalant" },
      "customer@avalant.co.th": { name: "Avalant Client User", role: "customer", orgId: "org_avalant" },
    };

    if (mockAccounts[username]) {
      const mock = mockAccounts[username];
      return reply.send({
        success: true,
        token: `ticketx_mock_${mock.role}_token_${Date.now()}`,
        user: {
          username,
          name: mock.name,
          role: mock.role,
          email: username,
          orgId: mock.orgId,
        },
      });
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

