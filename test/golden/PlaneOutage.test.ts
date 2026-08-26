import assert from "assert";
import { describe, it } from "node:test";
import { PlaneApiClient } from "../../src/services/PlaneApiClient";
import { PlaneProjectConfig } from "../../src/services/PlaneProjectResolver";
import { classifyOutboxFailure, backoffMs } from "../../src/infrastructure/db/OutboxFailureClassifier";

/**
 * Golden Flow with Plane temporarily unavailable.
 *
 * The requirement: the customer is still acknowledged, the TicketX ticket
 * still exists, the outbox retains the Plane operation, and when Plane
 * recovers the ticket synchronises exactly once with no duplicate work item.
 *
 * The customer-facing and ticket halves are covered against the live database
 * in GoldenFlow.live.test.ts — neither touches Plane, which is the point.
 * This file covers the Plane half, driven through a fake transport so an
 * outage can be produced deliberately.
 */

const projectConfig: PlaneProjectConfig = {
  workspaceSlug: "cs-team",
  planeProjectId: "staging-proj",
  apiBaseUrl: "https://plane.test",
  credentialRef: "plane_api_staging_key",
};

const payload = {
  name: "502 Bad Gateway",
  description_html: "<p>customer report</p>",
  priority: "high",
  external_source: "TicketX" as const,
  external_id: "TCK-GF-OUTAGE",
};

function outage(kind: "down" | "timeout" | "reset" | "500") {
  const err: any = new Error(
    kind === "500" ? "Request failed with status code 500" : "connect ECONNREFUSED"
  );
  if (kind === "500") err.response = { status: 500, headers: {} };
  if (kind === "down") err.code = "ECONNREFUSED";
  if (kind === "timeout") err.code = "ECONNABORTED";
  if (kind === "reset") err.code = "ECONNRESET";
  return err;
}

/** Fake transport whose POST behaviour changes when Plane "recovers". */
function planeThatRecovers(failures: number, existingAfterFailure = false) {
  let posts = 0;
  let gets = 0;
  return {
    posts: () => posts,
    gets: () => gets,
    client: {
      post: async () => {
        posts += 1;
        if (posts <= failures) throw outage("down");
        return { data: { id: "plane-uuid-recovered" } };
      },
      get: async () => {
        gets += 1;
        return {
          data: {
            results: existingAfterFailure
              ? [{ id: "plane-uuid-created-during-outage", external_id: payload.external_id }]
              : [],
          },
        };
      },
      patch: async () => ({ data: {} }),
      delete: async () => ({ data: {} }),
    } as any,
  };
}

describe("Golden Flow with Plane unavailable", () => {
  it("OUTAGE-001: Plane being down is transient, so the outbox keeps the operation", () => {
    for (const kind of ["down", "timeout", "reset", "500"] as const) {
      assert.strictEqual(
        classifyOutboxFailure(outage(kind)),
        "transient",
        `${kind} must not be dead-lettered`
      );
    }
    // ...and it is retried on a growing delay rather than in a hot loop.
    assert.ok(backoffMs(1) >= 60_000);
    assert.ok(backoffMs(5) > backoffMs(1));
  });

  it("OUTAGE-002: the ticket synchronises exactly once when Plane recovers", async () => {
    // Two attempts fail while Plane is down, the third succeeds.
    const fake = planeThatRecovers(2);
    const result = await new PlaneApiClient(fake.client).createWorkItem(projectConfig, payload);

    assert.strictEqual(result.id, "plane-uuid-recovered");
    assert.strictEqual(fake.posts(), 3, "one create per attempt, no more");
  });

  it("OUTAGE-003: a work item created during the outage is not duplicated on recovery", async () => {
    // The classic case: Plane accepted the create, then the connection died,
    // so the client never saw the response. On retry it must reconcile rather
    // than create a second work item.
    const fake = planeThatRecovers(99, /* existingAfterFailure */ true);
    const result = await new PlaneApiClient(fake.client).createWorkItem(projectConfig, payload);

    assert.strictEqual(result.id, "plane-uuid-created-during-outage");
    assert.strictEqual(fake.posts(), 1, "reconciliation must prevent a second create");
    assert.ok(fake.gets() >= 1, "recovery must look before it leaps");
  });

  it("OUTAGE-004: a sustained outage gives up without inventing an issue id", async () => {
    const fake = planeThatRecovers(99, /* existingAfterFailure */ false);
    await assert.rejects(
      () => new PlaneApiClient(fake.client).createWorkItem(projectConfig, payload),
      "a permanently unreachable Plane must surface an error, not a fabricated id"
    );
  });

  it("OUTAGE-005: the credential is never exposed by an outage error", async () => {
    const fake = planeThatRecovers(99, false);
    try {
      await new PlaneApiClient(fake.client).createWorkItem(projectConfig, payload);
      assert.fail("should have thrown");
    } catch (err: any) {
      const serialised = JSON.stringify({ message: err.message, stack: err.stack });
      assert.ok(
        !serialised.includes(projectConfig.credentialRef),
        "an outage error reaches outbox_events.error_message and the logs"
      );
    }
  });
});
