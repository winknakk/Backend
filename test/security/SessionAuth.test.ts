import assert from "assert";
import { describe, it } from "node:test";
import { SessionTokenService, AuthPrincipal } from "../../src/infrastructure/security/SessionTokenService";
import { hashPassword, verifyPassword } from "../../src/infrastructure/security/PasswordHasher";

const SECRET = "a".repeat(48);

const operator: AuthPrincipal = {
  kind: "operator",
  subject: "10",
  email: "admin.win@ticketx.local",
  role: "agent",
  orgId: "org_excise",
  projectIds: [101],
};

describe("SessionTokenService", () => {
  it("AUTH-003: issues a token that verifies back to the same principal", () => {
    const svc = new SessionTokenService(SECRET, 12);
    const { token } = svc.issue(operator);
    const verified = svc.verify(token);

    assert.ok(verified);
    assert.strictEqual(verified.subject, "10");
    assert.strictEqual(verified.role, "agent");
    assert.strictEqual(verified.orgId, "org_excise");
    assert.deepStrictEqual(verified.projectIds, [101]);
  });

  it("AUTH-002: rejects a tampered signature", () => {
    const svc = new SessionTokenService(SECRET, 12);
    const { token } = svc.issue(operator);
    const [h, b] = token.split(".");
    assert.strictEqual(svc.verify(`${h}.${b}.notavalidsignature`), null);
  });

  it("AUTH-002: rejects a payload edited to escalate scope", () => {
    const svc = new SessionTokenService(SECRET, 12);
    const { token } = svc.issue(operator);
    const [h, b, sig] = token.split(".");

    const payload = JSON.parse(Buffer.from(b, "base64url").toString("utf8"));
    payload.role = "super_admin";
    payload.orgId = null;
    payload.projectIds = null;
    const forged = Buffer.from(JSON.stringify(payload)).toString("base64url");

    // Signature no longer matches the edited payload.
    assert.strictEqual(svc.verify(`${h}.${forged}.${sig}`), null);
  });

  it("rejects a token signed with a different secret", () => {
    const issuer = new SessionTokenService(SECRET, 12);
    const verifier = new SessionTokenService("b".repeat(48), 12);
    const { token } = issuer.issue(operator);
    assert.strictEqual(verifier.verify(token), null);
  });

  it("rejects an expired token", async () => {
    const svc = new SessionTokenService(SECRET, 1);
    const { token } = svc.issue(operator);
    const [h, b, _sig] = token.split(".");
    const payload = JSON.parse(Buffer.from(b, "base64url").toString("utf8"));
    payload.exp = Math.floor(Date.now() / 1000) - 60;
    const staleBody = Buffer.from(JSON.stringify(payload)).toString("base64url");
    // Re-sign so only expiry — not the signature — can be the reason it fails.
    const resigned = new SessionTokenService(SECRET, 1);
    const rebuilt = `${h}.${staleBody}.${(resigned as any).sign(`${h}.${staleBody}`)}`;
    assert.strictEqual(svc.verify(rebuilt), null);
  });

  it("rejects malformed input without throwing", () => {
    const svc = new SessionTokenService(SECRET, 12);
    for (const bad of ["", "a", "a.b", "a.b.c.d", "...", "null"]) {
      assert.strictEqual(svc.verify(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it("refuses a secret that is too short to sign with", () => {
    assert.throws(() => new SessionTokenService("short", 12), /at least 32 characters/);
  });
});

describe("PasswordHasher", () => {
  it("accepts the correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    assert.strictEqual(await verifyPassword("correct horse battery staple", hash), true);
    assert.strictEqual(await verifyPassword("wrong password entirely", hash), false);
  });

  it("produces a different hash each time (salted)", async () => {
    const a = await hashPassword("same-password-value");
    const b = await hashPassword("same-password-value");
    assert.notStrictEqual(a, b);
    assert.strictEqual(await verifyPassword("same-password-value", a), true);
    assert.strictEqual(await verifyPassword("same-password-value", b), true);
  });

  it("AUTH-001: rejects every empty or malformed stored hash", async () => {
    // Operators with no password_hash must never authenticate. Before this
    // change the login route matched accounts by name alone.
    for (const stored of [null, undefined, "", "notahash", "scrypt$1$xx", "bcrypt$1$a$b"]) {
      assert.strictEqual(await verifyPassword("anything", stored as any), false, `stored=${stored}`);
    }
  });
});
