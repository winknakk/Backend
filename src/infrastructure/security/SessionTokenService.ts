import { createHmac, timingSafeEqual, randomUUID } from "crypto";

/**
 * Compact HMAC-SHA256 signed session tokens (JWT-shaped, HS256).
 *
 * Implemented on node:crypto rather than a JWT library so the auth path adds
 * no new dependency. The format is deliberately JWT-compatible so it can be
 * swapped for a standard library later without changing callers.
 */

export type PrincipalKind = "operator" | "service" | "customer";

export interface AuthPrincipal {
  kind: PrincipalKind;
  /** Operator id, "service", or customer identityId. */
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
   * For customer: MUST BE [projectId] (never null).
   */
  projectIds: number[] | null;
  /** Profile id for customer principals. */
  profileId?: string;
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
   * The token families this service is the door for.
   *
   * Customer and guest credentials are signed by `JwtUtil` with
   * `getWebchatJwtSecret()` — which returns the *same* `SESSION_SECRET` this
   * service signs operator sessions with. Their signatures therefore verify
   * here, and before this list existed that was the whole check: a customer or
   * guest token was returned as a principal whose `kind` was `undefined` and
   * whose `orgId`/`projectIds` were both null, which `resolveTenantScope` read
   * as UNRESTRICTED. An anonymous WebChat visitor could call every operator and
   * admin route (ISSUE-057, reproduced live at `GET /api/admin/conversations`
   * returning 200 for a guest token).
   *
   * `issue()` has always stamped `kind`, and it is only ever called with
   * operator principals, so requiring one of these locks out nothing that was
   * legitimately issued here.
   */
  private static readonly OPERATOR_SIDE_KINDS: readonly PrincipalKind[] = ["operator", "service"];

  /**
   * Returns the principal for a valid, unexpired token of an accepted family,
   * or null. Never throws on malformed input — callers treat null as
   * "not authenticated".
   *
   * `allow` names the families the caller is a door for. It defaults to the
   * operator side; pass an explicit list to authenticate a different class.
   * A token whose `kind` is missing, unrecognised, or outside `allow` is
   * rejected — absence of a family is never treated as permission.
   */
  verify(token: string, opts?: { allow?: readonly PrincipalKind[] }): AuthPrincipal | null {
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

    // Fail closed on the token family. A valid signature proves the token was
    // minted with this secret; it does not say what the token is *for*.
    const allow = opts?.allow ?? SessionTokenService.OPERATOR_SIDE_KINDS;
    if (typeof payload.kind !== "string" || !allow.includes(payload.kind)) {
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
