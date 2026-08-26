import assert from "assert";
import { describe, it } from "node:test";
import { PlaneApiClient, PlaneWorkItemPayload } from "../../src/services/PlaneApiClient";
import { PlaneProjectConfig } from "../../src/services/PlaneProjectResolver";

/**
 * Covers the PLANE-001..PLANE-009 rows of the E2E QA matrix against a fake
 * transport, so Plane failure handling is verifiable without touching a live
 * Plane workspace.
 */

const projectConfig: PlaneProjectConfig = {
  workspaceSlug: "cs-team",
  planeProjectId: "09aa9c0e-8448-426f-8128-306c3dcf9d78",
  apiBaseUrl: "https://plane.test",
  credentialRef: "plane_api_test_key",
};

const payload: PlaneWorkItemPayload = {
  name: "Login is down",
  description_html: "<p>506</p>",
  priority: "high",
  external_source: "TicketX",
  external_id: "TCK-2026-0001",
};

function httpError(status: number | undefined, extra: Record<string, unknown> = {}) {
  const err: any = new Error(status ? `Request failed with status code ${status}` : "socket hang up");
  if (status !== undefined) {
    err.response = { status, headers: extra.headers || {}, data: extra.data };
  }
  if (extra.code) err.code = extra.code;
  return err;
}

/** Minimal axios stand-in that records calls and replays scripted outcomes. */
function fakeHttp(script: {
  post?: Array<() => any>;
  get?: Array<() => any>;
  patch?: Array<() => any>;
}) {
  const calls = { post: 0, get: 0, patch: 0 };
  const take = (kind: "post" | "get" | "patch") => {
    const queue = script[kind] || [];
    const step = queue[Math.min(calls[kind], queue.length - 1)];
    calls[kind] += 1;
    if (!step) throw new Error(`unexpected ${kind} call`);
    return step();
  };
  return {
    calls,
    client: {
      post: async () => take("post"),
      get: async () => take("get"),
      patch: async () => take("patch"),
      delete: async () => ({ data: {} }),
    } as any,
  };
}

describe("PlaneApiClient failure handling", () => {
  it("PLANE-001: returns the Plane UUID on a successful create", async () => {
    const { client } = fakeHttp({ post: [() => ({ data: { id: "plane-uuid-1" } })] });
    const result = await new PlaneApiClient(client).createWorkItem(projectConfig, payload);
    assert.strictEqual(result.id, "plane-uuid-1");
  });

  it("PLANE-002/003/004: does NOT retry 401, 403 or 404", async () => {
    for (const status of [401, 403, 404]) {
      const fake = fakeHttp({ post: [() => { throw httpError(status); }] });
      await assert.rejects(() => new PlaneApiClient(fake.client).createWorkItem(projectConfig, payload));
      assert.strictEqual(fake.calls.post, 1, `status ${status} must not be retried`);
    }
  });

  it("PLANE-005: resolves the real Plane UUID on 409 instead of echoing the TicketX id", async () => {
    const fake = fakeHttp({
      post: [() => { throw httpError(409); }],
      get: [() => ({ data: { results: [{ id: "plane-uuid-existing", external_id: "TCK-2026-0001" }] } })],
    });
    const result = await new PlaneApiClient(fake.client).createWorkItem(projectConfig, payload);
    assert.strictEqual(result.id, "plane-uuid-existing");
    assert.notStrictEqual(result.id, payload.external_id);
  });

  it("PLANE-005b: fails loudly when a 409 cannot be reconciled to a work item", async () => {
    const fake = fakeHttp({
      post: [() => { throw httpError(409); }],
      get: [() => ({ data: { results: [] } })],
    });
    await assert.rejects(
      () => new PlaneApiClient(fake.client).createWorkItem(projectConfig, payload),
      (err: Error) => err.message.includes("PLANE_CONFLICT_UNRESOLVED")
    );
  });

  it("PLANE-006: retries 429 and honours Retry-After", async () => {
    let attempts = 0;
    const fake = fakeHttp({
      post: [
        () => {
          attempts += 1;
          if (attempts === 1) throw httpError(429, { headers: { "retry-after": "0" } });
          return { data: { id: "plane-uuid-2" } };
        },
      ],
      get: [() => ({ data: { results: [] } })],
    });
    const result = await new PlaneApiClient(fake.client).createWorkItem(projectConfig, payload);
    assert.strictEqual(result.id, "plane-uuid-2");
    assert.strictEqual(attempts, 2, "429 must be retried");
  });

  it("PLANE-007: retries 500 and succeeds on a later attempt", async () => {
    let attempts = 0;
    const fake = fakeHttp({
      post: [
        () => {
          attempts += 1;
          if (attempts === 1) throw httpError(500);
          return { data: { id: "plane-uuid-3" } };
        },
      ],
      get: [() => ({ data: { results: [] } })],
    });
    const result = await new PlaneApiClient(fake.client).createWorkItem(projectConfig, payload);
    assert.strictEqual(result.id, "plane-uuid-3");
    assert.strictEqual(attempts, 2);
  });

  it("PLANE-008/009: a timeout that Plane actually applied does not create a duplicate", async () => {
    let posts = 0;
    const fake = fakeHttp({
      // Every POST times out from the client's point of view.
      post: [() => { posts += 1; throw httpError(undefined, { code: "ECONNABORTED" }); }],
      // ...but Plane did create the issue on the first one.
      get: [() => ({ data: { results: [{ id: "plane-uuid-created-anyway", external_id: "TCK-2026-0001" }] } })],
    });

    const result = await new PlaneApiClient(fake.client).createWorkItem(projectConfig, payload);

    assert.strictEqual(result.id, "plane-uuid-created-anyway");
    assert.strictEqual(posts, 1, "reconciliation must prevent a second create attempt");
  });

  it("patchWorkItem retries transient failures without reconciliation", async () => {
    let attempts = 0;
    const fake = fakeHttp({
      patch: [
        () => {
          attempts += 1;
          if (attempts < 3) throw httpError(503);
          return { data: {} };
        },
      ],
    });
    await new PlaneApiClient(fake.client).patchWorkItem(projectConfig, "plane-uuid-1", { name: "x" });
    assert.strictEqual(attempts, 3);
    assert.strictEqual(fake.calls.get, 0, "PATCH is idempotent and must not trigger a lookup");
  });

  it("gives up after the retry budget is exhausted", async () => {
    const fake = fakeHttp({
      patch: [() => { throw httpError(503); }],
    });
    await assert.rejects(() =>
      new PlaneApiClient(fake.client).patchWorkItem(projectConfig, "plane-uuid-1", { name: "x" })
    );
    assert.strictEqual(fake.calls.patch, 3, "1 initial attempt + 2 retries");
  });
});
