import assert from "assert";
import { describe, it, before } from "node:test";
import { SessionTokenService, AuthPrincipal } from "../../src/infrastructure/security/SessionTokenService";

/**
 * Decision 2: every /api/v1/internal/* endpoint requires authenticated
 * service-to-service authorization, and a human operator credential must not
 * silently confer it.
 *
 * These exercise the authorization decision directly. The end-to-end HTTP
 * behaviour is verified separately against a running server; see
 * docs/INTERNAL_API_CALLER_AUDIT.md.
 */

const SECRET = "s".repeat(48);
const tokens = new SessionTokenService(SECRET, 12);

const serviceP: AuthPrincipal = {
  kind: "service", subject: "service", role: "service", orgId: null, projectIds: null,
};
const superAdminP: AuthPrincipal = {
  kind: "operator", subject: "10", email: "admin.win@ticketx.local",
  role: "super_admin", orgId: null, projectIds: null,
};
const scopedAdminP: AuthPrincipal = {
  kind: "operator", subject: "9", email: "admin.good@ticketx.local",
  role: "admin", orgId: "org_default", projectIds: [1, 2, 8],
};

/** Mirrors authHook's public-route list. */
const PUBLIC_PREFIXES = ["/health", "/webhook/message", "/api/v1/auth/", "/api/v1/webchat", "/api/v1/webhooks", "/api/v1/media/"];
const isPublic = (url: string) => {
  const p = url.split("?")[0];
  return PUBLIC_PREFIXES.some((r) => (r.endsWith("/") ? p.startsWith(r) : p === r || p.startsWith(`${r}/`)));
};

/** Every internal endpoint the backend exposes, as of this commit. */
const INTERNAL_ENDPOINTS = [
  "/api/v1/internal/tickets",
  "/api/v1/internal/tickets/promote",
  "/api/v1/internal/tickets/close",
  "/api/v1/internal/tickets/reopen",
  "/api/v1/internal/tickets/merge",
  "/api/v1/internal/tickets/status",
  "/api/v1/internal/tickets/assign",
  "/api/v1/internal/tickets/details",
  "/api/v1/internal/tickets/update-summary",
  "/api/v1/internal/tickets/update-plane",
  "/api/v1/internal/conversations",
  "/api/v1/internal/conversations/reply",
  "/api/v1/internal/conversations/search",
  "/api/v1/internal/conversations/takeover",
  "/api/v1/internal/conversations/details",
  "/api/v1/internal/conversations/identity",
  "/api/v1/internal/identities/search",
  "/api/v1/internal/identities/details",
  "/api/v1/internal/profiles/details",
  "/api/v1/internal/companies/details",
  "/api/v1/internal/messages",
  "/api/v1/internal/notifications/sms",
  "/api/v1/internal/sessions/resolve",
  "/api/v1/internal/config/prompts",
  "/api/v1/internal/rag",
  "/api/v1/internal/debug-log",
  "/api/v1/internal/knowledge/git-webhook",
  "/api/v1/internal/knowledge/search-codebase",
];

describe("Internal API authorization (SEC-05)", () => {
  it("INT-001: no internal endpoint is on the public-route list", () => {
    // /api/v1/internal/ was previously in authHook's skip list, making every
    // one of these reachable with no credential even when API_KEY was set.
    const leaked = INTERNAL_ENDPOINTS.filter(isPublic);
    assert.deepStrictEqual(leaked, [], `these bypass authentication: ${leaked.join(", ")}`);
  });

  it("INT-002: no credential produces no principal", () => {
    for (const bad of ["", "   "]) {
      assert.strictEqual(tokens.verify(bad), null);
    }
  });

  it("INT-003: an invalid credential produces no principal", () => {
    for (const bad of ["WRONG", "Bearer WRONG", "a.b.c", "null"]) {
      assert.strictEqual(tokens.verify(bad), null, `accepted: ${bad}`);
    }
  });

  it("INT-004: an expired service token is rejected", () => {
    const shortLived = new SessionTokenService(SECRET, 1);
    const { token } = shortLived.issue(serviceP);
    const [h, b] = token.split(".");
    const payload = JSON.parse(Buffer.from(b, "base64url").toString("utf8"));
    payload.exp = Math.floor(Date.now() / 1000) - 1;
    const staleBody = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const resigned = `${h}.${staleBody}.${(shortLived as any).sign(`${h}.${staleBody}`)}`;
    assert.strictEqual(shortLived.verify(resigned), null);
  });

  it("INT-005: a valid service credential resolves to an unrestricted service principal", () => {
    const { token } = tokens.issue(serviceP);
    const p = tokens.verify(token);
    assert.ok(p);
    assert.strictEqual(p.kind, "service");
    assert.strictEqual(p.orgId, null);
    assert.strictEqual(p.projectIds, null);
  });

  it("INT-006: a human operator token never becomes a service principal", () => {
    // A human credential authenticates, but it must stay an operator: the
    // service identity is separate and is not conferred by logging in.
    for (const human of [superAdminP, scopedAdminP]) {
      const { token } = tokens.issue(human);
      const p = tokens.verify(token);
      assert.ok(p);
      assert.strictEqual(p.kind, "operator", `${human.role} was promoted to service`);
      assert.notStrictEqual(p.role, "service");
    }
  });

  it("INT-007: editing a token to claim the service kind is rejected", () => {
    const { token } = tokens.issue(scopedAdminP);
    const [h, b, sig] = token.split(".");
    const payload = JSON.parse(Buffer.from(b, "base64url").toString("utf8"));
    payload.kind = "service";
    payload.orgId = null;
    payload.projectIds = null;
    const forged = Buffer.from(JSON.stringify(payload)).toString("base64url");
    assert.strictEqual(tokens.verify(`${h}.${forged}.${sig}`), null);
  });

  it("INT-008: tenant scope survives authentication", () => {
    // Authenticating as a scoped operator must not widen scope.
    const { token } = tokens.issue(scopedAdminP);
    const p = tokens.verify(token);
    assert.ok(p);
    assert.strictEqual(p.orgId, "org_default");
    assert.deepStrictEqual(p.projectIds, [1, 2, 8]);
    assert.ok(!p.projectIds!.includes(101), "scoped operator must not reach org_excise");
  });
});
