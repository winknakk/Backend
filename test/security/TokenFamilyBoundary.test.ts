import assert from "assert";
import { describe, it } from "node:test";
import { createHmac } from "crypto";
import { SessionTokenService, AuthPrincipal } from "../../src/infrastructure/security/SessionTokenService";
import { resolveTenantScope } from "../../src/middleware/tenantScope";

/**
 * ISSUE-057 — an anonymous WebChat guest could act as an unrestricted operator.
 *
 * `getWebchatJwtSecret()` returns the same `SESSION_SECRET` that
 * `SessionTokenService` signs operator sessions with, and both emit HS256
 * `header.body.signature`. A customer or guest token therefore *verified* at
 * the operator boundary. `verify()` checked only signature and `exp`, returning
 * `kind: undefined, orgId: null, projectIds: null` — and `resolveTenantScope`
 * read "both null" as UNRESTRICTED. Reproduced live before the fix:
 * `GET /api/admin/conversations` answered **200** to a guest token and to a
 * customer token, and 401 with no credential at all.
 *
 * These tests pin the two assertions that close it: the operator door accepts
 * only operator-side families, and unrestricted scope has to be earned by an
 * explicit family rather than inferred from absent claims.
 */

const SECRET = "test-session-secret-at-least-32-characters-long";
const svc = new SessionTokenService(SECRET, 1);

const b64u = (v: string) =>
  Buffer.from(v).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Mints a token the way `JwtUtil` does — same secret, same shape, any claims. */
function foreignToken(payload: Record<string, unknown>, ttl = 3600): string {
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttl }));
  const sig = b64u(createHmac("sha256", SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

const operatorPrincipal: AuthPrincipal = {
  kind: "operator",
  subject: "op-1",
  role: "super_admin",
  orgId: null,
  projectIds: null,
};

describe("the operator door accepts only operator-side token families", () => {
  it("S057-2 — a guest token is refused", () => {
    const token = foreignToken({ role: "guest", identityId: "1135", channelRef: "fa775e9b", kind: "guest" });
    assert.strictEqual(svc.verify(token), null);
  });

  it("S057-3 — a customer token is refused", () => {
    const token = foreignToken({ role: "customer", profileId: "999", projectId: "101", kind: "customer" });
    assert.strictEqual(svc.verify(token), null);
  });

  it("S057-8 — an unknown family is refused", () => {
    assert.strictEqual(svc.verify(foreignToken({ kind: "wizard", role: "admin" })), null);
    assert.strictEqual(svc.verify(foreignToken({ kind: 42, role: "admin" })), null);
  });

  it("S057-9 — a legacy token with NO kind is refused, however wide its claims look", () => {
    // The exact shape that used to authenticate: valid signature, no family,
    // no scope. It must not be readable as a principal at all.
    const token = foreignToken({ role: "customer", profileId: "999" });
    assert.strictEqual(svc.verify(token), null, "absent family must never be accepted");
  });

  it("S057-4 — a genuine operator token is still accepted", () => {
    const { token } = svc.issue(operatorPrincipal);
    const principal = svc.verify(token);
    assert.ok(principal, "an operator session must keep working");
    assert.strictEqual(principal.kind, "operator");
    assert.strictEqual(principal.role, "super_admin");
  });

  it("a service token is still accepted", () => {
    const { token } = svc.issue({ kind: "service", subject: "service", role: "service", orgId: null, projectIds: null });
    assert.strictEqual(svc.verify(token)?.kind, "service");
  });

  it("S057-10 — an expired operator token is refused", () => {
    const expired = new SessionTokenService(SECRET, -1).issue(operatorPrincipal);
    assert.strictEqual(svc.verify(expired.token), null);
  });

  it("a token signed with another secret is refused", () => {
    const other = new SessionTokenService("a-completely-different-secret-32-chars!!", 1).issue(operatorPrincipal);
    assert.strictEqual(svc.verify(other.token), null);
  });

  it("malformed input is refused without throwing", () => {
    for (const bad of ["", "abc", "a.b", "a.b.c", "...", "eyJ.eyJ.sig"]) {
      assert.strictEqual(svc.verify(bad as string), null, `should refuse ${JSON.stringify(bad)}`);
    }
  });

  it("an explicit allow list can admit another family without widening the default", () => {
    const customer = foreignToken({ kind: "customer", role: "customer", profileId: "999" });
    assert.strictEqual(svc.verify(customer), null, "default door stays operator-side");
    assert.strictEqual(svc.verify(customer, { allow: ["customer"] })?.kind, "customer");
  });
});

describe("unrestricted tenant scope must be earned, never inferred from absent claims", () => {
  it("S057-9 — a customer principal with null scope gets nothing, not everything", async () => {
    const scope = await resolveTenantScope({
      kind: "customer",
      subject: "1135",
      role: "customer",
      orgId: null,
      projectIds: null,
    });
    assert.strictEqual(scope.unrestricted, false, "must not be unrestricted");
    assert.deepStrictEqual(scope.projectIds, [], "must grant no projects");
  });

  it("a principal with an unrecognised family and null scope gets nothing", async () => {
    const scope = await resolveTenantScope({
      kind: "wizard" as any,
      subject: "x",
      role: "admin",
      orgId: null,
      projectIds: null,
    });
    assert.strictEqual(scope.unrestricted, false);
    assert.deepStrictEqual(scope.projectIds, []);
  });

  it("service and operator principals keep unrestricted scope", async () => {
    for (const kind of ["service", "operator"] as const) {
      const scope = await resolveTenantScope({ kind, subject: "s", role: "super_admin", orgId: null, projectIds: null });
      assert.strictEqual(scope.unrestricted, true, `${kind} must stay unrestricted`);
    }
  });

  it("a confined customer principal keeps exactly its own project", async () => {
    const scope = await resolveTenantScope({
      kind: "customer",
      subject: "1135",
      role: "customer",
      orgId: "org_excise",
      projectIds: [101],
    });
    assert.strictEqual(scope.unrestricted, false);
    assert.deepStrictEqual(scope.projectIds, [101]);
  });
});

describe("issuance stamps a family on every customer-side token", () => {
  it("no customer or guest token is minted without a kind", async () => {
    const fs = await import("fs");
    const files = [
      "../../src/presentation/http/routes/WebChatGateway.ts",
      "../../src/api/routes/portal.ts",
      "../../src/api/routes/auth.ts",
    ];
    let stamped = 0;
    for (const f of files) {
      const src = fs.readFileSync(new URL(f, import.meta.url), "utf8");
      stamped += (src.match(/kind: "customer"|kind: isGuest \? "guest" : "customer"/g) || []).length;
    }
    assert.strictEqual(stamped, 7, "all seven customer/guest issuance sites must stamp a family");
  });
});
