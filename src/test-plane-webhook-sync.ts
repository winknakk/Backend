import assert from "assert";
import crypto from "crypto";
import { DatabaseAdapter } from "./adapters/types";
import {
  mapPlanePriorityToTicketPriority,
  mapTicketPriorityToPlanePriority,
  mapPlaneStateToTicketStatus,
  PlaneWebhookService,
  verifyPlaneWebhookSignature,
} from "./services/planeWebhookService";
import { planeStatusToLifecycle } from "./domain/ticket/TicketLifecycle";

async function run(): Promise<void> {
  // These map a Plane webhook state onto Plane's own vocabulary, which is
  // what tickets.plane_status stores. The lifecycle mapping is separate and
  // lives in TicketLifecycle.planeStatusToLifecycle.
  assert.strictEqual(mapPlaneStateToTicketStatus({ name: "Backlog", group: "backlog" }), "Backlog");
  assert.strictEqual(mapPlaneStateToTicketStatus({ name: "Done", group: "completed" }), "Done");
  assert.strictEqual(mapPlaneStateToTicketStatus({ name: "Todo", group: "unstarted" }), "Todo");
  assert.strictEqual(mapPlaneStateToTicketStatus({ group: "started" }), "In Progress");
  assert.strictEqual(mapPlaneStateToTicketStatus({ name: "Cancelled" }), "Cancelled");
  assert.strictEqual(mapPlanePriorityToTicketPriority("urgent"), "Urgent");
  assert.strictEqual(mapPlanePriorityToTicketPriority("high"), "High");
  assert.strictEqual(mapPlanePriorityToTicketPriority("medium"), "Medium");
  assert.strictEqual(mapPlanePriorityToTicketPriority("low"), "Low");
  assert.strictEqual(mapPlanePriorityToTicketPriority("none"), "None");
  assert.strictEqual(mapTicketPriorityToPlanePriority("P1"), "urgent");
  assert.strictEqual(mapTicketPriorityToPlanePriority("Medium"), "medium");

  const payload = {
    event: "issue",
    action: "update",
    data: {
      id: "plane-issue-1",
      priority: "high",
      state_detail: { name: "Done", group: "completed" },
    },
  };
  const secret = "test-plane-webhook-secret";
  const signature = crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
  assert.strictEqual(verifyPlaneWebhookSignature(payload, signature, secret), true);
  assert.strictEqual(verifyPlaneWebhookSignature(payload, "invalid", secret), false);

  let captured: any;
  let currentStatus = "In Progress";
  let doneNotificationCount = 0;
  let deletedPlaneIssueId: string | undefined;
  const adapter = {
    async syncTicketFromPlane(planeIssueId: string, changes: { status?: string; priority?: string }) {
      captured = { planeIssueId, changes };
      const previousStatus = currentStatus;
      if (changes.status) currentStatus = changes.status;
      return {
        matched: true,
        statusChanged: Boolean(changes.status && previousStatus !== currentStatus),
        previousStatus,
        currentStatus,
      };
    },
    async deleteTicketFromPlane(planeIssueId: string) {
      deletedPlaneIssueId = planeIssueId;
      return true;
    },
  } as DatabaseAdapter;
  const service = new PlaneWebhookService(adapter, undefined, async () => {
    doneNotificationCount += 1;
  });
  const result = await service.sync(payload);

  // Since migration 040 the adapter only receives priority. Status goes
  // through TicketStateMachine, which owns the asymmetric reverse mapping
  // (Plane "Done" -> TicketX RESOLVED, never CLOSED) and the audit trail.
  assert.deepStrictEqual(captured, {
    planeIssueId: "plane-issue-1",
    changes: { priority: "High" },
  });
  assert.strictEqual(result.processed, true);

  // The state machine needs a real ticket row to act on, which this fake
  // adapter does not provide, so the lifecycle half of this path is covered
  // against the live database in test/domain/TicketStateMachine.live.test.ts
  // ("applyPlaneStatus: Plane Done resolves but never closes"), including
  // that a repeated Done does not notify twice.

  // Plane sets completed_at on cancelled work items too. Cancelled must never
  // be flattened into Done — that would take the ticket down the resolution
  // path and ask the customer to confirm a fix that never happened.
  //
  // The adapter no longer sees status, so the property is asserted where it
  // now lives: the state resolver, and the lifecycle mapping it feeds.
  assert.strictEqual(
    mapPlaneStateToTicketStatus({ name: "Cancelled", group: "cancelled" }),
    "Cancelled",
    "a cancelled Plane state must stay Cancelled even when completed_at is set"
  );
  assert.strictEqual(
    planeStatusToLifecycle("Cancelled", "IN_PROGRESS"),
    "CANCELLED",
    "Cancelled must map to CANCELLED, never RESOLVED"
  );
  assert.notStrictEqual(planeStatusToLifecycle("Cancelled", "IN_PROGRESS"), "RESOLVED");

  const deleteResult = await service.sync({
    event: "issue",
    action: "delete",
    data: { id: "plane-issue-1" },
  });
  assert.strictEqual(deletedPlaneIssueId, "plane-issue-1");
  assert.strictEqual(deleteResult.processed, true);
  assert.strictEqual(deleteResult.matched, true);
  assert.strictEqual(deleteResult.deleted, true);

  console.log("Plane webhook reverse-sync tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
