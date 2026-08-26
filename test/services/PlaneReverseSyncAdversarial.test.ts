import assert from "assert";
import { describe, it } from "node:test";
import { planeStatusToLifecycle, TicketLifecycleStatus } from "../../src/domain/ticket/TicketLifecycle";
import { classifyOutboxFailure } from "../../src/infrastructure/db/OutboxFailureClassifier";
import { PlaneApiClient } from "../../src/services/PlaneApiClient";
import { PlaneProjectConfig } from "../../src/services/PlaneProjectResolver";

/**
 * Reverse-sync and Plane-integration edge cases that are not covered by the
 * happy path: repeated webhooks, out-of-order and stale deliveries, an
 * archived mapping, a historical ticket, and credential handling.
 */

const projectConfig: PlaneProjectConfig = {
  workspaceSlug: "cs-team",
  planeProjectId: "proj-1",
  apiBaseUrl: "https://plane.test",
  credentialRef: "plane_api_secret_value_do_not_log",
};

describe("Reverse sync — repeated and unchanged deliveries", () => {
  it("RS-001: an unchanged Plane state produces no lifecycle change", () => {
    // The poller reads the same state every 30s. Each of these must be a
    // no-op or reverse sync churns the table, which is what provoked the 429s.
    assert.strictEqual(planeStatusToLifecycle("In Progress", "IN_PROGRESS"), null);
    assert.strictEqual(planeStatusToLifecycle("Cancelled", "CANCELLED"), null);
    assert.strictEqual(planeStatusToLifecycle("Done", "RESOLVED"), null);
  });

  it("RS-002: a duplicate webhook is idempotent", () => {
    // Same delivery twice: the first advances the ticket, the second changes
    // nothing, so no second customer notification is queued.
    let state: TicketLifecycleStatus = "IN_PROGRESS";
    const first = planeStatusToLifecycle("Done", state);
    assert.strictEqual(first, "RESOLVED");
    state = first!;
    assert.strictEqual(planeStatusToLifecycle("Done", state), null, "the duplicate must be inert");
  });

  it("RS-003: an out-of-order webhook does not drag the ticket backwards", () => {
    // A stale "In Progress" delivered after "Done" must not undo the
    // resolution and re-open a ticket the customer is being asked to confirm.
    assert.strictEqual(planeStatusToLifecycle("In Progress", "RESOLVED"), "IN_PROGRESS");
    // ...but once the customer has acted, nothing from Plane may override it.
    assert.strictEqual(planeStatusToLifecycle("In Progress", "CUSTOMER_CONFIRMED"), "IN_PROGRESS");
    assert.strictEqual(planeStatusToLifecycle("Backlog", "CUSTOMER_CONFIRMED"), null);
    assert.strictEqual(planeStatusToLifecycle("Done", "CLOSED"), null);
  });

  it("RS-004: a stale Backlog delivery never resets a ticket in flight", () => {
    for (const current of ["IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"] as TicketLifecycleStatus[]) {
      assert.strictEqual(planeStatusToLifecycle("Backlog", current), null, `from ${current}`);
    }
  });

  it("RS-005: a state that is waiting on a person is not overridden by Plane", () => {
    assert.strictEqual(planeStatusToLifecycle("In Progress", "WAITING_CUSTOMER"), null);
    assert.strictEqual(planeStatusToLifecycle("Open", "WAITING_INTERNAL"), null);
  });

  it("RS-006: an unknown or empty Plane state is ignored rather than guessed", () => {
    for (const bad of ["", "  ", null, undefined, "Triaged", "Blocked", "42"]) {
      assert.strictEqual(planeStatusToLifecycle(bad as any, "OPEN"), null, `state=${bad}`);
    }
  });
});

describe("Reverse sync — failure classification", () => {
  it("RS-007: Plane being unavailable is transient, not permanent", () => {
    const err: any = new Error("connect ECONNREFUSED");
    err.code = "ECONNREFUSED";
    assert.strictEqual(classifyOutboxFailure(err), "transient");
  });

  it("RS-008: a connection reset mid-request is transient", () => {
    const err: any = new Error("socket hang up");
    err.code = "ECONNRESET";
    assert.strictEqual(classifyOutboxFailure(err), "transient");
  });

  it("RS-009: an archived or missing mapping is blocked, not retried forever", () => {
    assert.strictEqual(classifyOutboxFailure(new Error("PLANE_MAPPING_NOT_FOUND")), "blocked");
    assert.strictEqual(
      classifyOutboxFailure(new Error("PLANE_CREDENTIAL_ERROR: Empty credentialRef provided")),
      "blocked"
    );
  });

  it("RS-010: a historical ticket whose Plane issue is gone is permanent", () => {
    const err: any = new Error("Request failed with status code 404");
    err.response = { status: 404 };
    assert.strictEqual(classifyOutboxFailure(err), "permanent");
  });
});

describe("Plane client — connection reset and credential handling", () => {
  function fakeHttp(script: Array<() => any>) {
    let n = 0;
    return {
      calls: () => n,
      client: {
        post: async () => {
          const step = script[Math.min(n, script.length - 1)];
          n += 1;
          return step();
        },
        get: async () => ({ data: { results: [] } }),
        patch: async () => ({ data: {} }),
        delete: async () => ({ data: {} }),
      } as any,
    };
  }

  it("PLANE-011: a connection reset is retried", async () => {
    const fake = fakeHttp([
      () => {
        const e: any = new Error("socket hang up");
        e.code = "ECONNRESET";
        throw e;
      },
      () => ({ data: { id: "plane-uuid-after-reset" } }),
    ]);
    const result = await new PlaneApiClient(fake.client).createWorkItem(projectConfig, {
      name: "n", description_html: "d", priority: "none",
      external_source: "TicketX", external_id: "TCK-RESET",
    });
    assert.strictEqual(result.id, "plane-uuid-after-reset");
    assert.ok(fake.calls() >= 2, "a reset must be retried");
  });

  it("PLANE-012: the credential never appears in a thrown error", async () => {
    // An error that escapes to a log or an outbox error_message must not
    // carry the API key with it.
    const fake = fakeHttp([
      () => {
        const e: any = new Error("Request failed with status code 401");
        e.response = { status: 401, headers: {} };
        throw e;
      },
    ]);
    await assert.rejects(
      () =>
        new PlaneApiClient(fake.client).createWorkItem(projectConfig, {
          name: "n", description_html: "d", priority: "none",
          external_source: "TicketX", external_id: "TCK-LEAK",
        }),
      (err: Error) => {
        assert.ok(
          !JSON.stringify(err.message).includes(projectConfig.credentialRef),
          "the credential must not be embedded in the error message"
        );
        return true;
      }
    );
  });

  it("PLANE-013: an unresolvable credential fails closed rather than falling back", () => {
    const client = new PlaneApiClient({} as any);
    assert.throws(
      () => (client as any).getHeaders({ ...projectConfig, credentialRef: "" }),
      /PLANE_CREDENTIAL_ERROR/,
      "an empty credentialRef must throw, not silently use a default key"
    );
    assert.throws(
      () => (client as any).getHeaders({ ...projectConfig, credentialRef: "env:DEFINITELY_NOT_SET_QA" }),
      /PLANE_CREDENTIAL_ERROR/
    );
  });
});
