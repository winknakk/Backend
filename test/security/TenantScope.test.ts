import assert from "assert";
import { describe, it } from "node:test";
import { resolveProjectFilter, canAccessProject, TenantScope } from "../../src/middleware/tenantScope";

/**
 * Covers TENANT-001 (cross-org), TENANT-002 (cross-project) and TENANT-003
 * (enumeration / projectId=all) at the authorization-decision level.
 */

function fakeRequest(scope: TenantScope | undefined) {
  return { tenantScope: scope, principal: { subject: "9" } } as any;
}

function fakeReply() {
  const sent: { status?: number; body?: any } = {};
  const reply: any = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    send(body: any) {
      sent.body = body;
      return reply;
    },
    sent,
  };
  return reply;
}

const unrestricted: TenantScope = { unrestricted: true, orgId: null, projectIds: [] };
const orgDefault: TenantScope = { unrestricted: false, orgId: "org_default", projectIds: [1, 2, 8, 11, 12] };
const noProjects: TenantScope = { unrestricted: false, orgId: "org_avalant", projectIds: [] };

describe("resolveProjectFilter", () => {
  it("TENANT-002: denies a project outside the caller's grant", () => {
    const reply = fakeReply();
    const result = resolveProjectFilter(fakeRequest(orgDefault), reply, 101);
    assert.strictEqual(result, null);
    assert.strictEqual(reply.sent.status, 403);
  });

  it("TENANT-003: does not leak whether an out-of-scope project exists", () => {
    // A real out-of-scope project and a nonexistent one must be
    // indistinguishable, otherwise ids can be enumerated.
    const realButForeign = fakeReply();
    resolveProjectFilter(fakeRequest(orgDefault), realButForeign, 101);
    const nonexistent = fakeReply();
    resolveProjectFilter(fakeRequest(orgDefault), nonexistent, 999999);

    assert.strictEqual(realButForeign.sent.status, nonexistent.sent.status);
    assert.strictEqual(realButForeign.sent.body.error, nonexistent.sent.body.error);
  });

  it("allows a project inside the caller's grant", () => {
    const reply = fakeReply();
    const result = resolveProjectFilter(fakeRequest(orgDefault), reply, 8);
    assert.deepStrictEqual(result, { projectIds: [8] });
    assert.strictEqual(reply.sent.status, undefined);
  });

  it("TENANT-003: projectId=all is bounded to the caller's own projects", () => {
    const reply = fakeReply();
    const result = resolveProjectFilter(fakeRequest(orgDefault), reply, "all");
    assert.deepStrictEqual(result, { projectIds: [1, 2, 8, 11, 12] });
  });

  it("projectId=all stays unbounded only for unrestricted callers", () => {
    const reply = fakeReply();
    const result = resolveProjectFilter(fakeRequest(unrestricted), reply, "all");
    assert.deepStrictEqual(result, { projectIds: null });
  });

  it("a missing projectId is treated as 'all', not as 'unfiltered'", () => {
    const reply = fakeReply();
    const result = resolveProjectFilter(fakeRequest(orgDefault), reply, undefined);
    assert.deepStrictEqual(result, { projectIds: [1, 2, 8, 11, 12] });
  });

  it("refuses a caller with no project grants rather than showing everything", () => {
    const reply = fakeReply();
    assert.strictEqual(resolveProjectFilter(fakeRequest(noProjects), reply, "all"), null);
    assert.strictEqual(reply.sent.status, 403);
  });

  it("refuses a request that never acquired a scope", () => {
    const reply = fakeReply();
    assert.strictEqual(resolveProjectFilter(fakeRequest(undefined), reply, 1), null);
    assert.strictEqual(reply.sent.status, 403);
  });

  it("rejects a malformed projectId", () => {
    for (const bad of ["abc", "-1", "0", "null", "undefined", "1;DROP TABLE"]) {
      const reply = fakeReply();
      assert.strictEqual(resolveProjectFilter(fakeRequest(orgDefault), reply, bad), null, `bad=${bad}`);
      assert.strictEqual(reply.sent.status, 400, `bad=${bad}`);
    }
  });
});

describe("canAccessProject", () => {
  it("gates row-level access by the caller's scope", () => {
    assert.strictEqual(canAccessProject(fakeRequest(orgDefault), 8), true);
    assert.strictEqual(canAccessProject(fakeRequest(orgDefault), 101), false);
    assert.strictEqual(canAccessProject(fakeRequest(unrestricted), 101), true);
  });

  it("denies when the project is missing or unparseable", () => {
    assert.strictEqual(canAccessProject(fakeRequest(orgDefault), null), false);
    assert.strictEqual(canAccessProject(fakeRequest(orgDefault), undefined), false);
    assert.strictEqual(canAccessProject(fakeRequest(orgDefault), "not-a-number"), false);
  });

  it("denies when the request has no scope at all", () => {
    assert.strictEqual(canAccessProject(fakeRequest(undefined), 1), false);
  });
});
