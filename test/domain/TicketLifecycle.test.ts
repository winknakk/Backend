import assert from "assert";
import { describe, it } from "node:test";
import {
  TICKET_LIFECYCLE_STATUSES,
  TicketLifecycleStatus,
  canTransition,
  customerNotificationFor,
  isTerminal,
  lifecycleToPlaneStatus,
  nextStatuses,
  planeStatusToLifecycle,
  shouldPushToPlane,
} from "../../src/domain/ticket/TicketLifecycle";

describe("Forward mapping: TicketX lifecycle -> Plane", () => {
  it("matches the approved mapping exactly", () => {
    const expected: Record<string, string> = {
      NEW: "Backlog",
      TRIAGED: "Backlog",
      OPEN: "Open",
      IN_PROGRESS: "Open",
      WAITING_CUSTOMER: "Open",
      WAITING_INTERNAL: "Open",
      RESOLVED: "Done",
      CUSTOMER_CONFIRMED: "Done",
      CLOSED: "Done",
      REOPENED: "Open",
      CANCELLED: "Cancelled",
    };
    for (const status of TICKET_LIFECYCLE_STATUSES) {
      assert.strictEqual(lifecycleToPlaneStatus(status), expected[status], `mapping for ${status}`);
    }
  });

  it("every lifecycle status maps to something", () => {
    for (const status of TICKET_LIFECYCLE_STATUSES) {
      assert.ok(lifecycleToPlaneStatus(status), `${status} has no Plane mapping`);
    }
  });
});

describe("Plane push suppression (no status ping-pong)", () => {
  it("does not re-push Done when the customer confirms or the ticket closes", () => {
    // All three are Done in Plane. Pushing again would be a no-op write that
    // reverse sync then reads back.
    assert.strictEqual(shouldPushToPlane("RESOLVED", "CUSTOMER_CONFIRMED"), false);
    assert.strictEqual(shouldPushToPlane("CUSTOMER_CONFIRMED", "CLOSED"), false);
    assert.strictEqual(shouldPushToPlane("RESOLVED", "CLOSED"), false);
  });

  it("does not push between statuses that share a Plane state", () => {
    assert.strictEqual(shouldPushToPlane("NEW", "TRIAGED"), false);
    assert.strictEqual(shouldPushToPlane("OPEN", "IN_PROGRESS"), false);
    assert.strictEqual(shouldPushToPlane("IN_PROGRESS", "WAITING_CUSTOMER"), false);
    assert.strictEqual(shouldPushToPlane("WAITING_CUSTOMER", "WAITING_INTERNAL"), false);
  });

  it("does push when the engineering state genuinely changes", () => {
    assert.strictEqual(shouldPushToPlane("TRIAGED", "OPEN"), true);
    assert.strictEqual(shouldPushToPlane("IN_PROGRESS", "RESOLVED"), true);
    assert.strictEqual(shouldPushToPlane("RESOLVED", "REOPENED"), true);
    assert.strictEqual(shouldPushToPlane("OPEN", "CANCELLED"), true);
  });
});

describe("Reverse mapping: Plane -> TicketX lifecycle", () => {
  it("Plane Done produces RESOLVED, never CLOSED", () => {
    // The single most important rule in the two-layer model.
    for (const current of ["NEW", "TRIAGED", "OPEN", "IN_PROGRESS", "WAITING_INTERNAL"] as TicketLifecycleStatus[]) {
      assert.strictEqual(planeStatusToLifecycle("Done", current), "RESOLVED", `from ${current}`);
    }
  });

  it("Plane Done never closes or confirms a ticket", () => {
    for (const variant of ["Done", "done", "Completed", "complete"]) {
      for (const current of TICKET_LIFECYCLE_STATUSES) {
        const next = planeStatusToLifecycle(variant, current);
        assert.notStrictEqual(next, "CLOSED", `${variant} from ${current} produced CLOSED`);
        assert.notStrictEqual(next, "CUSTOMER_CONFIRMED", `${variant} from ${current} confirmed`);
      }
    }
  });

  it("Plane Done is a no-op once the customer has moved the ticket on", () => {
    // Otherwise reverse sync would drag a CLOSED ticket back to RESOLVED on
    // every poll and re-notify the customer.
    for (const current of ["RESOLVED", "CUSTOMER_CONFIRMED", "CLOSED"] as TicketLifecycleStatus[]) {
      assert.strictEqual(planeStatusToLifecycle("Done", current), null, `from ${current}`);
    }
  });

  it("does not drag a ticket backwards when Plane reports Backlog", () => {
    assert.strictEqual(planeStatusToLifecycle("Backlog", "NEW"), "TRIAGED");
    assert.strictEqual(planeStatusToLifecycle("Backlog", "IN_PROGRESS"), null);
    assert.strictEqual(planeStatusToLifecycle("Backlog", "RESOLVED"), null);
  });

  it("does not override a state that is waiting on a person", () => {
    assert.strictEqual(planeStatusToLifecycle("In Progress", "WAITING_CUSTOMER"), null);
    assert.strictEqual(planeStatusToLifecycle("In Progress", "WAITING_INTERNAL"), null);
  });

  it("returns null for an unchanged state, so nothing is written", () => {
    assert.strictEqual(planeStatusToLifecycle("In Progress", "IN_PROGRESS"), null);
    assert.strictEqual(planeStatusToLifecycle("Cancelled", "CANCELLED"), null);
  });

  it("normalises the wider vocabulary Plane actually emits", () => {
    assert.strictEqual(planeStatusToLifecycle("Todo", "NEW"), "TRIAGED");
    assert.strictEqual(planeStatusToLifecycle("unstarted", "NEW"), "TRIAGED");
    assert.strictEqual(planeStatusToLifecycle("started", "OPEN"), "IN_PROGRESS");
    assert.strictEqual(planeStatusToLifecycle("canceled", "OPEN"), "CANCELLED");
  });

  it("ignores unknown, empty and null states", () => {
    for (const bad of ["", "   ", null, undefined, "Nonsense"]) {
      assert.strictEqual(planeStatusToLifecycle(bad as any, "OPEN"), null, `state=${bad}`);
    }
  });
});

describe("Transition authorization", () => {
  it("LIFE-001: the full happy path is valid", () => {
    const journey: Array<[TicketLifecycleStatus, TicketLifecycleStatus, any]> = [
      ["NEW", "TRIAGED", "system"],
      ["TRIAGED", "OPEN", "operator"],
      ["OPEN", "IN_PROGRESS", "operator"],
      ["IN_PROGRESS", "WAITING_CUSTOMER", "operator"],
      ["WAITING_CUSTOMER", "IN_PROGRESS", "customer"],
      ["IN_PROGRESS", "RESOLVED", "plane"],
      ["RESOLVED", "CUSTOMER_CONFIRMED", "customer"],
      ["CUSTOMER_CONFIRMED", "CLOSED", "system"],
    ];
    for (const [from, to, actor] of journey) {
      const r = canTransition(from, to, actor);
      assert.ok(r.allowed, `${from} -> ${to} as ${actor}: ${r.reason}`);
    }
  });

  it("LIFE-002: the rejection path is valid", () => {
    assert.ok(canTransition("RESOLVED", "REOPENED", "customer").allowed);
    assert.ok(canTransition("REOPENED", "IN_PROGRESS", "operator").allowed);
  });

  it("LIFE-003: cancellation is valid", () => {
    assert.ok(canTransition("OPEN", "CANCELLED", "operator").allowed);
  });

  it("Plane cannot confirm or close on the customer's behalf", () => {
    const confirm = canTransition("RESOLVED", "CUSTOMER_CONFIRMED", "plane");
    assert.strictEqual(confirm.allowed, false);
    assert.strictEqual(confirm.code, "ACTOR_NOT_PERMITTED");

    // CLOSED is not even reachable from RESOLVED for anyone: the customer
    // must confirm first.
    const close = canTransition("RESOLVED", "CLOSED", "operator");
    assert.strictEqual(close.allowed, false);
    assert.strictEqual(close.code, "INVALID_TRANSITION");
  });

  it("a customer cannot drive engineering states", () => {
    for (const [from, to] of [["OPEN", "IN_PROGRESS"], ["IN_PROGRESS", "RESOLVED"], ["OPEN", "CANCELLED"]] as any[]) {
      const r = canTransition(from, to, "customer");
      assert.strictEqual(r.allowed, false, `customer performed ${from} -> ${to}`);
    }
  });

  it("rejects skipping the customer confirmation step", () => {
    assert.strictEqual(canTransition("IN_PROGRESS", "CLOSED", "operator").allowed, false);
    assert.strictEqual(canTransition("NEW", "CLOSED", "system").allowed, false);
    assert.strictEqual(canTransition("OPEN", "CUSTOMER_CONFIRMED", "operator").allowed, false);
  });

  it("rejects a no-op transition rather than writing it", () => {
    const r = canTransition("OPEN", "OPEN", "operator");
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.code, "NO_OP");
  });

  it("rejects unknown statuses and actors", () => {
    assert.strictEqual(canTransition("Backlog" as any, "OPEN", "operator").code, "UNKNOWN_STATUS");
    assert.strictEqual(canTransition("OPEN", "Done" as any, "operator").code, "UNKNOWN_STATUS");
    assert.strictEqual(canTransition("OPEN", "IN_PROGRESS", "nobody" as any).code, "ACTOR_NOT_PERMITTED");
  });

  it("nextStatuses only offers transitions the actor may actually perform", () => {
    assert.deepStrictEqual(nextStatuses("RESOLVED", "customer").sort(), ["CUSTOMER_CONFIRMED", "REOPENED"]);
    assert.deepStrictEqual(nextStatuses("RESOLVED", "plane"), []);
  });
});

describe("Terminal states and notifications", () => {
  it("RESOLVED is not terminal - it waits on the customer", () => {
    assert.strictEqual(isTerminal("RESOLVED"), false);
    assert.strictEqual(isTerminal("CLOSED"), true);
    assert.strictEqual(isTerminal("CANCELLED"), true);
  });

  it("only RESOLVED asks the customer to confirm", () => {
    assert.strictEqual(customerNotificationFor("RESOLVED"), "resolution_confirmation_request");
    assert.strictEqual(customerNotificationFor("CLOSED"), "closed");
    assert.strictEqual(customerNotificationFor("REOPENED"), "reopened");
    for (const quiet of ["NEW", "TRIAGED", "OPEN", "IN_PROGRESS", "WAITING_INTERNAL", "CUSTOMER_CONFIRMED"] as TicketLifecycleStatus[]) {
      assert.strictEqual(customerNotificationFor(quiet), null, `${quiet} should be silent`);
    }
  });
});

describe("No status ping-pong", () => {
  it("a Plane-driven RESOLVED does not bounce back to Plane", () => {
    // Plane says Done -> TicketX RESOLVED. Pushing RESOLVED back would write
    // Done again, which reverse sync reads, and so on.
    const next = planeStatusToLifecycle("Done", "IN_PROGRESS");
    assert.strictEqual(next, "RESOLVED");
    // The push check is what breaks the loop: IN_PROGRESS is Open, RESOLVED
    // is Done, so the first hop is a genuine change...
    assert.strictEqual(shouldPushToPlane("IN_PROGRESS", "RESOLVED"), true);
    // ...but everything after it is not.
    assert.strictEqual(shouldPushToPlane("RESOLVED", "CUSTOMER_CONFIRMED"), false);
    assert.strictEqual(shouldPushToPlane("CUSTOMER_CONFIRMED", "CLOSED"), false);
    // And re-reading Done while CLOSED changes nothing.
    assert.strictEqual(planeStatusToLifecycle("Done", "CLOSED"), null);
  });
});
