import assert from "assert";
import { describe, it } from "node:test";
import { PlaneReverseSyncPoller } from "../../src/services/PlaneReverseSyncPoller";

/** Records how many cycles actually reached the sync service. */
function fakeService(responses: any[]) {
  let calls = 0;
  return {
    calls: () => calls,
    service: {
      syncLinkedTicketsFromPlane: async () => {
        const r = responses[Math.min(calls, responses.length - 1)];
        calls += 1;
        return r;
      },
    } as any,
  };
}

const clean = { checked: 19, skipped: 16, updated: 0, deleted: 0, unlinked: 0, failed: 0 };
const throttled = { checked: 6, skipped: 2, updated: 0, deleted: 0, unlinked: 0, failed: 3, rateLimited: true, retryAfterMs: 60_000 };

describe("PlaneReverseSyncPoller rate-limit cooldown", () => {
  it("polls normally when Plane is not rate limiting", async () => {
    const fake = fakeService([clean]);
    const poller = new PlaneReverseSyncPoller(fake.service);
    await poller.runOnce();
    await poller.runOnce();
    assert.strictEqual(fake.calls(), 2);
  });

  it("skips the next cycle after Plane rate-limits us", async () => {
    // Polling straight through a 429 is what progressively deepened the
    // throttle: 19 work items re-fetched every 30 seconds.
    const fake = fakeService([throttled]);
    const poller = new PlaneReverseSyncPoller(fake.service);

    await poller.runOnce();
    assert.strictEqual(fake.calls(), 1);

    await poller.runOnce();
    assert.strictEqual(fake.calls(), 1, "second cycle must be suppressed by the cooldown");
  });

  it("resumes once the cooldown has elapsed", async () => {
    const fake = fakeService([{ ...throttled, retryAfterMs: 1 }, clean]);
    const poller = new PlaneReverseSyncPoller(fake.service);

    await poller.runOnce();
    await new Promise((r) => setTimeout(r, 15));
    await poller.runOnce();
    assert.strictEqual(fake.calls(), 2);
  });

  it("clears the cooldown after a clean cycle", async () => {
    const fake = fakeService([{ ...throttled, retryAfterMs: 1 }, clean, clean]);
    const poller = new PlaneReverseSyncPoller(fake.service);

    await poller.runOnce();
    await new Promise((r) => setTimeout(r, 15));
    await poller.runOnce();
    await poller.runOnce();
    assert.strictEqual(fake.calls(), 3, "a clean cycle must not leave a cooldown behind");
  });

  it("does not run concurrently with itself", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const service: any = {
      syncLinkedTicketsFromPlane: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return clean;
      },
    };
    const poller = new PlaneReverseSyncPoller(service);
    await Promise.all([poller.runOnce(), poller.runOnce(), poller.runOnce()]);
    assert.strictEqual(maxInFlight, 1);
  });

  it("survives a throwing sync service", async () => {
    const service: any = {
      syncLinkedTicketsFromPlane: async () => {
        throw new Error("Plane unreachable");
      },
    };
    const poller = new PlaneReverseSyncPoller(service);
    await poller.runOnce(); // must not reject
    assert.ok(true);
  });
});
