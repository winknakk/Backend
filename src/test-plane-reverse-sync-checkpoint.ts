import assert from "node:assert/strict";
import { shouldCheckpointPlaneVersion } from "./services/planeWebhookService";

assert.equal(
  shouldCheckpointPlaneVersion({ processed: true, matched: true, status: "Delivery to Customer" }),
  true,
  "an applied/matched Delivery-to-Customer version is safe to checkpoint"
);
assert.equal(
  shouldCheckpointPlaneVersion({ processed: true, matched: true, reason: "no_change" }),
  true,
  "a recognized no-change result is safe to checkpoint"
);
assert.equal(
  shouldCheckpointPlaneVersion({ processed: false, matched: false, reason: "no_supported_changes" }),
  false,
  "an unresolved Plane state must remain retryable"
);
assert.equal(
  shouldCheckpointPlaneVersion({ processed: true, matched: false, reason: "ticket_not_linked" }),
  false,
  "an unmatched Plane version must remain retryable"
);

console.log("Plane reverse-sync checkpoint regression: 4/4 passed");
