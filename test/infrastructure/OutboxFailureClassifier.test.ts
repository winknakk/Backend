import assert from "assert";
import { describe, it } from "node:test";
import { classifyOutboxFailure, backoffMs } from "../../src/infrastructure/db/OutboxFailureClassifier";

function httpError(status: number, message = `Request failed with status code ${status}`) {
  const err: any = new Error(message);
  err.response = { status };
  return err;
}

describe("classifyOutboxFailure", () => {
  it("treats the nine real dead letters as permanent", () => {
    // These sat in the queue for 19 days being retried. Plane rejected the
    // payload itself, so no number of retries could ever have worked.
    assert.strictEqual(classifyOutboxFailure(new Error("Custom Id cannot be integers")), "permanent");
  });

  it("treats a missing payload field as permanent", () => {
    assert.strictEqual(
      classifyOutboxFailure(new Error("Ticket ID is missing in outbox payload")),
      "permanent"
    );
    assert.strictEqual(
      classifyOutboxFailure(new Error("Plane work-item ID is missing in outbox payload")),
      "permanent"
    );
  });

  it("treats 401/403 as blocked, not as something to retry", () => {
    assert.strictEqual(classifyOutboxFailure(httpError(401)), "blocked");
    assert.strictEqual(classifyOutboxFailure(httpError(403)), "blocked");
  });

  it("treats unresolvable credentials and mappings as blocked", () => {
    assert.strictEqual(
      classifyOutboxFailure(new Error("PLANE_CREDENTIAL_ERROR: Empty credentialRef provided")),
      "blocked"
    );
    assert.strictEqual(classifyOutboxFailure(new Error("PLANE_MAPPING_NOT_FOUND")), "blocked");
  });

  it("treats other 4xx as permanent", () => {
    assert.strictEqual(classifyOutboxFailure(httpError(400)), "permanent");
    assert.strictEqual(classifyOutboxFailure(httpError(404)), "permanent");
    assert.strictEqual(classifyOutboxFailure(httpError(422)), "permanent");
  });

  it("treats 429 and 5xx as transient", () => {
    assert.strictEqual(classifyOutboxFailure(httpError(429)), "transient");
    for (const s of [500, 502, 503, 504]) {
      assert.strictEqual(classifyOutboxFailure(httpError(s)), "transient", `status ${s}`);
    }
  });

  it("treats a network failure with no HTTP status as transient", () => {
    const err: any = new Error("socket hang up");
    err.code = "ECONNRESET";
    assert.strictEqual(classifyOutboxFailure(err), "transient");
    assert.strictEqual(classifyOutboxFailure(new Error("timeout of 10000ms exceeded")), "transient");
  });

  it("classifies an unresolvable Plane conflict as permanent", () => {
    assert.strictEqual(
      classifyOutboxFailure(new Error("PLANE_CONFLICT_UNRESOLVED: duplicate for external_id TCK-1")),
      "permanent"
    );
  });
});

describe("backoffMs", () => {
  it("grows exponentially from one minute", () => {
    assert.strictEqual(backoffMs(1), 60_000);
    assert.strictEqual(backoffMs(2), 120_000);
    assert.strictEqual(backoffMs(3), 240_000);
  });

  it("caps at one hour so a long outage is not a hot loop", () => {
    assert.strictEqual(backoffMs(50), 3_600_000);
  });

  it("never returns a negative or zero delay", () => {
    for (const a of [0, -1, 1]) {
      assert.ok(backoffMs(a) >= 60_000, `attempts=${a}`);
    }
  });
});
