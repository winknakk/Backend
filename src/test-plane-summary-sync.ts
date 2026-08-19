import assert from "assert";
import {
  PlaneService,
  selectPlaneBacklogState,
  selectPlaneCancelledState,
} from "./services/planeService";

async function run(): Promise<void> {
  const states = [
    { id: "backlog", name: "Backlog", group: "backlog" },
    { id: "done", name: "Done", group: "completed" },
    { id: "cancelled", name: "Cancelled", group: "cancelled" },
  ];
  assert.strictEqual(selectPlaneBacklogState(states)?.id, "backlog");
  assert.strictEqual(selectPlaneCancelledState(states)?.id, "cancelled");

  const requests: Array<{ method: string; url: string; body?: any }> = [];
  const dbAdapter = {
    getTicketCompanyContext: async () => ({
      ticket: {
        ticket_id: "TCK-TEST",
        subject: "Test work item 511",
        summary: "Original report",
        running_summary: "- Original report\n- Screen flashes",
        last_ai_summary: "Screen flashes",
        plane_issue_id: "work-item-1",
        plane_workspace_slug: "ask-natapohn",
        plane_project_id: "e3454524-961a-4b84-8ccb-71575baaa696",
      },
      companyName: "Example",
    }),
    updateTicketPlaneIssue: async () => undefined,
    getConversationIdent: async () => undefined,
  } as any;
  const httpClient = {
    get: async (url: string) => {
      requests.push({ method: "GET", url });
      return { data: { id: "work-item-1", name: "Test work item 511" } };
    },
    patch: async (url: string, body: any) => {
      requests.push({ method: "PATCH", url, body });
      return { data: {} };
    },
    post: async () => ({ data: {} }),
  } as any;

  const result = await new PlaneService(dbAdapter, httpClient).syncTicketSummaryToPlane("TCK-TEST");

  assert.deepStrictEqual(result, { synced: true, planeIssueId: "work-item-1" });
  const patchReq = requests.find((r) => r.method === "PATCH");
  assert.ok(patchReq, "Expected a PATCH request");
  assert.match(patchReq.url, /\/issues\/work-item-1\/$/);
  assert.match(patchReq.body.name, /\[👤 Customer\] \[TCK-TEST\] Test work item 511/);
  assert.match(patchReq.body.description_html, /Customer update history/);
  assert.match(patchReq.body.description_html, /<li>Original report<\/li><li>Screen flashes<\/li>/);
  assert.match(patchReq.body.description_html, /Latest customer update/);
  assert.match(patchReq.body.description_html, /Screen flashes/);

  console.log("Plane summary sync tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
