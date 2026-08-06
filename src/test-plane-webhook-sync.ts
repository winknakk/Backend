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

async function run(): Promise<void> {
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

  assert.deepStrictEqual(captured, {
    planeIssueId: "plane-issue-1",
    changes: { status: "Done", priority: "High" },
  });
  assert.strictEqual(result.processed, true);
  assert.strictEqual(result.matched, true);
  assert.strictEqual(doneNotificationCount, 1);

  await service.sync(payload);
  assert.strictEqual(doneNotificationCount, 1, "Repeated Done sync must not notify twice");

  await service.sync({
    event: "issue",
    action: "update",
    data: {
      id: "plane-issue-1",
      completed_at: "2026-07-31T00:00:00.000Z",
      state_detail: { name: "Cancelled", group: "cancelled" },
    },
  });
  assert.deepStrictEqual(captured, {
    planeIssueId: "plane-issue-1",
    changes: { status: "Cancelled", priority: undefined },
  });

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
