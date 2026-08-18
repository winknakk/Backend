import { createLogger } from "../observability/logger";
import { TenantContext, createTenantContext } from "../domain/tenant/TenantContext";
import { ConstantSystemService } from "./ConstantSystemService";

const logger = createLogger("CentralAuthService");

export interface CenterLoginResponse {
  tokenType: string;
  token: string;
  IDToken?: string;
  expiresDate?: string;
  access_token?: string;
  id_token?: string;
}

export interface UserRoleProfile {
  email: string;
  userId: number | string;
  name: string;
  role: "super_admin" | "admin" | "employee" | "customer";
  orgId: string;
  rawAuthorities: string[];
  firstname?: string;
  lastname?: string;
  iam2_id?: string;
  position_name?: string;
  type?: string;
}

export interface CenterOrg {
  id: string;
  org_name?: string;
  description?: string;
  app_id?: string;
  organization_id?: string;
  org_department_code?: string;
  created_by?: string;
  created_date?: string;
}

export interface CenterUserRole {
  email: string;
  firstname: string;
  iam2_id: string;
  id: string;
  lastname: string;
  username: string;
  type: string;
  head?: string;
  position_name?: string;
}

export interface AddCenterRoleRequest {
  orgId: string;
  email: string;
  firstname: string;
  lastname: string;
  username?: string;
  type: string;
  head?: string;
  position_name?: string;
}

export interface CreateCenterOrgRequest {
  org_name: string;
  description?: string;
  org_department_code?: string;
  app_id?: string;
  initialManager?: {
    email: string;
    firstname?: string;
    lastname?: string;
    position_name?: string;
  };
}

export class CentralAuthService {
  private centerAuthUrl: string;

  constructor(centerAuthUrl: string = "https://centerapp.io/center/auth/login") {
    this.centerAuthUrl = centerAuthUrl;
  }

  /**
   * Authenticate directly with the Central IAM Server
   */
  async loginToCenter(username: string, password: string): Promise<CenterLoginResponse> {
    try {
      const payload = {
        username,
        password,
        fcmToken: null,
        deviceID: "5f9b0040-aea9-4496-ac71-8ee2b1119d7b",
        deviceToken: null,
        devicePlatform: "web",
        groupIam2ID: null,
      };

      const res = await fetch(this.centerAuthUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(`Center Auth failed with status: ${res.status}`);
      }

      const data = (await res.json()) as CenterLoginResponse;
      return data;
    } catch (err: any) {
      logger.warn({ error: err.message, username }, "Center Auth network call failed, attempting token parse or fallback");
      throw err;
    }
  }

  /**
   * Fetch organizations linked to user token from CM Service
   */
  async findOrgsByUser(token: string): Promise<CenterOrg[]> {
    try {
      const baseUrl = await ConstantSystemService.getCenterCmServiceUrl();
      const url = `${baseUrl}/org/find-orgs-byuser`;
      const authToken = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authToken,
          Accept: "*/*",
        },
      });

      if (!res.ok) {
        throw new Error(`findOrgsByUser failed with status: ${res.status}`);
      }

      return (await res.json()) as CenterOrg[];
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to fetch user orgs from Center CM Service");
      throw err;
    }
  }

  /**
   * Fetch my role for specific orgId from CM Service
   */
  async getMyRole(token: string, orgId: string): Promise<CenterUserRole> {
    try {
      const baseUrl = await ConstantSystemService.getCenterCmServiceUrl();
      const url = `${baseUrl}/org/get-my-role`;
      const authToken = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: authToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ orgId }),
      });

      if (!res.ok) {
        throw new Error(`getMyRole failed with status: ${res.status}`);
      }

      return (await res.json()) as CenterUserRole;
    } catch (err: any) {
      logger.error({ error: err.message, orgId }, "Failed to fetch my role from Center CM Service");
      throw err;
    }
  }

  /**
   * Fetch all user roles for specific orgId from CM Service
   */
  async getUserRoles(token: string, orgId: string): Promise<CenterUserRole[]> {
    try {
      const baseUrl = await ConstantSystemService.getCenterCmServiceUrl();
      const url = `${baseUrl}/org/get-user-roles`;
      const authToken = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: authToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ orgId }),
      });

      if (!res.ok) {
        throw new Error(`getUserRoles failed with status: ${res.status}`);
      }

      return (await res.json()) as CenterUserRole[];
    } catch (err: any) {
      logger.error({ error: err.message, orgId }, "Failed to fetch user roles from Center CM Service");
      throw err;
    }
  }

  /**
   * Add / assign role on Center CM Service
   */
  async addRoleToCenter(token: string, payload: AddCenterRoleRequest): Promise<{ success: boolean; data?: any }> {
    try {
      const baseUrl = await ConstantSystemService.getCenterCmServiceUrl();
      const url = `${baseUrl}/org/add-role`;
      const authToken = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

      const bodyPayload = {
        orgId: payload.orgId,
        email: payload.email,
        firstname: payload.firstname,
        lastname: payload.lastname,
        username: payload.username || payload.email,
        type: payload.type || "user",
        head: payload.head || "",
        position_name: payload.position_name || "Member",
      };

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: authToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodyPayload),
      });

      if (!res.ok) {
        // Fallback endpoint try /org/save-user-role
        const fallbackUrl = `${baseUrl}/org/save-user-role`;
        const fallbackRes = await fetch(fallbackUrl, {
          method: "POST",
          headers: {
            Authorization: authToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(bodyPayload),
        });
        if (!fallbackRes.ok) {
          throw new Error(`addRoleToCenter failed with status: ${res.status}`);
        }
        return { success: true, data: await fallbackRes.json() };
      }

      return { success: true, data: await res.json() };
    } catch (err: any) {
      logger.error({ error: err.message, payload }, "Failed to add role on Center CM Service");
      throw err;
    }
  }

  /**
   * Create new organization on Center CM Service
   */
  async createOrgOnCenter(token: string, payload: CreateCenterOrgRequest): Promise<{ success: boolean; org?: any; data?: any }> {
    try {
      const baseUrl = await ConstantSystemService.getCenterCmServiceUrl();
      const url = `${baseUrl}/org/create`;
      const authToken = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

      const bodyPayload = {
        org_name: payload.org_name,
        description: payload.description || "",
        org_department_code: payload.org_department_code || "",
        app_id: payload.app_id || "",
      };

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: authToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodyPayload),
      });

      if (!res.ok) {
        // Fallback endpoint try /org/save
        const fallbackUrl = `${baseUrl}/org/save`;
        const fallbackRes = await fetch(fallbackUrl, {
          method: "POST",
          headers: {
            Authorization: authToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(bodyPayload),
        });
        if (!fallbackRes.ok) {
          throw new Error(`createOrgOnCenter failed with status: ${res.status}`);
        }
        const createdOrgData = await fallbackRes.json();
        const newOrgId = createdOrgData?.id || createdOrgData?.orgId || createdOrgData?.data?.id;

        // Auto assign initial manager if provided
        if (payload.initialManager?.email && newOrgId) {
          try {
            await this.addRoleToCenter(token, {
              orgId: newOrgId,
              email: payload.initialManager.email,
              firstname: payload.initialManager.firstname || payload.initialManager.email.split('@')[0],
              lastname: payload.initialManager.lastname || '',
              type: 'manager',
              position_name: payload.initialManager.position_name || 'Organization Lead',
            });
          } catch (mgrErr: any) {
            logger.warn({ error: mgrErr.message, orgId: newOrgId }, "Could not auto-assign initial manager to created org");
          }
        }

        return { success: true, org: createdOrgData };
      }

      const createdOrg = await res.json();
      const newOrgId = createdOrg?.id || createdOrg?.orgId || createdOrg?.data?.id;

      // Auto assign initial manager if provided
      if (payload.initialManager?.email && newOrgId) {
        try {
          await this.addRoleToCenter(token, {
            orgId: newOrgId,
            email: payload.initialManager.email,
            firstname: payload.initialManager.firstname || payload.initialManager.email.split('@')[0],
            lastname: payload.initialManager.lastname || '',
            type: 'manager',
            position_name: payload.initialManager.position_name || 'Organization Lead',
          });
        } catch (mgrErr: any) {
          logger.warn({ error: mgrErr.message, orgId: newOrgId }, "Could not auto-assign initial manager to created org");
        }
      }

      return { success: true, org: createdOrg };
    } catch (err: any) {
      logger.error({ error: err.message, payload }, "Failed to create organization on Center CM Service");
      throw err;
    }
  }

  /**
   * Parses and maps JWT claims from Center Auth Response into TicketX UserRoleProfile
   */
  parseCenterJwt(token: string, idToken?: string): UserRoleProfile {
    try {
      const parts = token.split(".");
      if (parts.length < 2) {
        throw new Error("Invalid JWT token format");
      }

      const payloadJson = Buffer.from(parts[1], "base64").toString("utf-8");
      const decoded = JSON.parse(payloadJson);

      let decodedIdToken: any = null;
      if (idToken && idToken.includes(".")) {
        try {
          const idParts = idToken.split(".");
          if (idParts.length >= 2) {
            decodedIdToken = JSON.parse(Buffer.from(idParts[1], "base64").toString("utf-8"));
          }
        } catch (e) {
          // ignore invalid idToken
        }
      }

      const email =
        decoded.email ||
        decoded.user_name ||
        decoded.claims?.userinfo?.email ||
        decodedIdToken?.email ||
        decodedIdToken?.user_name ||
        decodedIdToken?.claims?.userinfo?.email ||
        "user@ticketx.io";
      const firstname =
        decoded.firstname ||
        decoded.claims?.userinfo?.given_name ||
        decodedIdToken?.firstname ||
        decodedIdToken?.claims?.userinfo?.given_name ||
        decodedIdToken?.given_name ||
        "";
      const lastname =
        decoded.lastname ||
        decoded.claims?.userinfo?.family_name ||
        decodedIdToken?.lastname ||
        decodedIdToken?.claims?.userinfo?.family_name ||
        decodedIdToken?.family_name ||
        "";
      const name = `${firstname} ${lastname}`.trim() || email;
      const userId = decoded.user_id || decoded.claims?.userinfo?.user_id || decodedIdToken?.claims?.userinfo?.user_id || 1;

      // Extract Authorities / Roles from both access_token and idToken
      const authorities: string[] = Array.isArray(decoded.authorities) ? [...decoded.authorities] : [];
      if (decodedIdToken && Array.isArray(decodedIdToken.authorities)) {
        authorities.push(...decodedIdToken.authorities);
      }

      if (decoded.system_id && typeof decoded.system_id === "object") {
        for (const sysKey of Object.keys(decoded.system_id)) {
          const sysRoles = decoded.system_id[sysKey]?.roles;
          if (Array.isArray(sysRoles)) {
            authorities.push(...sysRoles);
          }
        }
      }

      // Role Mapping Rules (High priority to Low priority)
      let role: "super_admin" | "admin" | "employee" | "customer" = "employee";
      const upperAuths = authorities.map((a) => String(a).toUpperCase());

      if (upperAuths.includes("ROLE_SUPERADMIN") || email.includes("superadmin")) {
        role = "super_admin";
      } else if (upperAuths.includes("ROLE_ADMIN") || upperAuths.includes("ADMIN")) {
        role = "admin";
      } else if (upperAuths.includes("CUSER") || upperAuths.includes("CUSTOMER")) {
        role = "customer";
      } else if (upperAuths.includes("ROLE_USER") || upperAuths.includes("USER") || upperAuths.includes("EMPLOYEE")) {
        role = "employee";
      }

      const orgId = decoded.group_id && Number(decoded.group_id) > 0 ? `org_${decoded.group_id}` : "org_avalant";

      return {
        email,
        userId,
        name,
        role,
        orgId,
        rawAuthorities: authorities,
        firstname,
        lastname,
      };
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to parse Center JWT token");
      return {
        email: "unknown@ticketx.io",
        userId: 0,
        name: "Unknown User",
        role: "employee",
        orgId: "org_default",
        rawAuthorities: [],
      };
    }
  }
}

