import { createLogger } from "../observability/logger";
import { TenantContext, createTenantContext } from "../domain/tenant/TenantContext";

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
   * Parses and maps JWT claims from Center Auth Response into TicketX UserRoleProfile
   */
  parseCenterJwt(token: string): UserRoleProfile {
    try {
      const parts = token.split(".");
      if (parts.length < 2) {
        throw new Error("Invalid JWT token format");
      }

      const payloadJson = Buffer.from(parts[1], "base64").toString("utf-8");
      const decoded = JSON.parse(payloadJson);

      const email = decoded.email || decoded.user_name || decoded.claims?.userinfo?.email || "user@ticketx.io";
      const firstname = decoded.firstname || decoded.claims?.userinfo?.given_name || "";
      const lastname = decoded.lastname || decoded.claims?.userinfo?.family_name || "";
      const name = `${firstname} ${lastname}`.trim() || email;
      const userId = decoded.user_id || decoded.claims?.userinfo?.user_id || 1;

      // Extract Authorities / Roles
      const authorities: string[] = Array.isArray(decoded.authorities) ? decoded.authorities : [];
      if (decoded.system_id && typeof decoded.system_id === "object") {
        for (const sysKey of Object.keys(decoded.system_id)) {
          const sysRoles = decoded.system_id[sysKey]?.roles;
          if (Array.isArray(sysRoles)) {
            authorities.push(...sysRoles);
          }
        }
      }

      // Role Mapping Rules
      let role: "super_admin" | "admin" | "employee" | "customer" = "employee";
      const upperAuths = authorities.map((a) => String(a).toUpperCase());

      if (upperAuths.includes("ROLE_SUPERADMIN") || email.includes("superadmin")) {
        role = "super_admin";
      } else if (upperAuths.includes("ROLE_ADMIN") || upperAuths.includes("ADMIN")) {
        role = "admin";
      } else if (upperAuths.includes("ROLE_USER") || upperAuths.includes("USER") || upperAuths.includes("EMPLOYEE")) {
        role = "employee";
      } else if (upperAuths.includes("CUSER") || upperAuths.includes("CUSTOMER")) {
        role = "customer";
      }

      const orgId = decoded.group_id && Number(decoded.group_id) > 0 ? `org_${decoded.group_id}` : "org_avalant";

      return {
        email,
        userId,
        name,
        role,
        orgId,
        rawAuthorities: authorities,
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
