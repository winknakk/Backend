import assert from "assert";
import crypto from "crypto";
import { DatabaseAdapter } from "./adapters/types";
import {
  mapPlanePriorityToTicketPriority,
  mapPlaneStateToTicketStatus,
  PlaneWebhookService,
  verifyPlaneWebhookSignature,
} from "./services/planeWebhookService";

async function run(): Promise<void> {
  assert.strictEqual(mapPlaneStateToTicketStatus({ name: "Done", group: "completed" }), "Done");
  assert.strictEqual(mapPlaneStateToTicketStatus({ group: "started" }), "In Progress");
  assert.strictEqual(mapPlaneStateToTicketStatus({ name: "Cancelled" }), "Cancelled");
  assert.strictEqual(mapPlanePriorityToTicketPriority("urgent"), "P1");
  assert.strictEqual(mapPlanePriorityToTicketPriority("high"), "P2");
  assert.strictEqual(mapPlanePriorityToTicketPriority("medium"), "P3");
  assert.strictEqual(mapPlanePriorityToTicketPriority("low"), "P4");

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
  const adapter = {
    async syncTicketFromPlane(planeIssueId: string, changes: { status?: string; priority?: string }) {
      captured = { planeIssueId, changes };
      return true;
    },
  } as DatabaseAdapter;
  const result = await new PlaneWebhookService(adapter).sync(payload);

  assert.deepStrictEqual(captured, {
    planeIssueId: "plane-issue-1",
    changes: { status: "Done", priority: "P2" },
  });
  assert.strictEqual(result.processed, true);
  assert.strictEqual(result.matched, true);

  console.log("Plane webhook reverse-sync tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
