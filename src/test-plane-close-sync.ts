import assert from "assert";
import { findMatchingPlaneWorkItem, PlaneService, selectPlaneTerminalState } from "./services/planeService";

async function run(): Promise<void> {
  const done = { id: "state-done", name: "Done", group: "completed" };
  const cancelled = { id: "state-cancelled", name: "Cancelled", group: "cancelled" };

  assert.strictEqual(selectPlaneTerminalState([cancelled, done])?.id, "state-done");
  assert.strictEqual(selectPlaneTerminalState([cancelled])?.id, "state-cancelled");
  assert.strictEqual(selectPlaneTerminalState([]), undefined);
  assert.strictEqual(
    findMatchingPlaneWorkItem("ระบบล่มขึ้น 405 Method Not Allowed", [
      { id: "work-item-405", name: "ระบบล่ม 405 Method Not Allowed" },
      { id: "work-item-502", name: "ระบบล่ม 502 Bad Gateway" },
    ])?.id,
    "work-item-405"
  );

  const requests: Array<{ method: string; url: string; body?: unknown }> = [];
  const dbAdapter = {
    getTicketCompanyContext: async () => ({
      ticket: { ticket_id: "TCK-TEST", subject: "Test work item", plane_issue_id: "work-item-1" },
      companyName: "Test",
    }),
    updateTicketPlaneIssue: async () => undefined,
  } as any;
  const httpClient = {
    get: async (url: string) => {
      requests.push({ method: "GET", url });
      if (url.includes("/work-items/work-item-1/")) {
        return { data: { id: "work-item-1", name: "Test work item" } };
      }
      return { data: { results: [cancelled, done] } };
    },
    patch: async (url: string, body: unknown) => {
      requests.push({ method: "PATCH", url, body });
      return { data: {} };
    },
    post: async () => ({ data: {} }),
  } as any;

  const service = new PlaneService(dbAdapter, httpClient);
  const result = await service.syncTicketClosureToPlane("TCK-TEST");

  assert.strictEqual(result.synced, true);
  assert.strictEqual(result.stateName, "Done");
  assert.strictEqual(requests[0].method, "GET");
  assert.match(requests[0].url, /\/work-items\/work-item-1\/$/);
  assert.strictEqual(requests[1].method, "GET");
  assert.match(requests[1].url, /\/states\/$/);
  assert.strictEqual(requests[2].method, "PATCH");
  assert.match(requests[2].url, /\/work-items\/work-item-1\/$/);
  assert.deepStrictEqual(requests[2].body, { state: "state-done" });

  console.log("Plane close sync tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
