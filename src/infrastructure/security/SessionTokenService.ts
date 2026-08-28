import { createHmac, timingSafeEqual, randomUUID } from "crypto";

/**
 * Compact HMAC-SHA256 signed session tokens (JWT-shaped, HS256).
 *
 * Implemented on node:crypto rather than a JWT library so the auth path adds
 * no new dependency. The format is deliberately JWT-compatible so it can be
 * swapped for a standard library later without changing callers.
 */

export type PrincipalKind = "operator" | "service";

export interface AuthPrincipal {
  kind: PrincipalKind;
  /** Operator id, or "service" for machine-to-machine callers. */
  subject: string;
  email?: string;
  role: string;
  /**
   * Organization the principal is confined to.
   * `null` means unrestricted (super_admin and service callers only).
   */
  orgId: string | null;
  /**
   * Projects the principal may access.
   * `null` means "every project inside orgId" (or every project when orgId is
   * also null). An empty array means no project access at all.
   */
  projectIds: number[] | null;
}

interface TokenPayload extends AuthPrincipal {
  iat: number;
  exp: number;
  jti: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
}

export class SessionTokenService {
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(secret: string, ttlHours: number) {
    // Fail closed. A fallback constant here would sign real sessions with a key
    // published in the repository, and would do it silently — the service would
    // look healthy while every token it issued was forgeable.
    if (!secret || secret.length < 32) {
      throw new Error("SESSION_SECRET must be at least 32 characters");
    }
    this.secret = secret;
    this.ttlSeconds = Math.floor(ttlHours * 3600);
  }

  private sign(data: string): string {
    return b64url(createHmac("sha256", this.secret).update(data).digest());
  }

  issue(principal: AuthPrincipal): { token: string; expiresAt: string } {
    const now = Math.floor(Date.now() / 1000);
    const payload: TokenPayload = {
      ...principal,
      iat: now,
      exp: now + this.ttlSeconds,
      jti: randomUUID(),
    };

    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64url(JSON.stringify(payload));
    const signature = this.sign(`${header}.${body}`);

    return {
      token: `${header}.${body}.${signature}`,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  }

  /**
   * Returns the principal for a valid, unexpired token, or null. Never throws
   * on malformed input — callers treat null as "not authenticated".
   */
  verify(token: string): AuthPrincipal | null {
    if (!token || typeof token !== "string") return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;

    const expected = this.sign(`${header}.${body}`);
    const given = Buffer.from(signature);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

    let payload: TokenPayload;
    try {
      payload = JSON.parse(b64urlDecode(body).toString("utf8"));
    } catch {
      return null;
    }

    if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    return {
      kind: payload.kind,
      subject: payload.subject,
      email: payload.email,
      role: payload.role,
      orgId: payload.orgId ?? null,
      projectIds: Array.isArray(payload.projectIds) ? payload.projectIds : null,
    };
  }
}
