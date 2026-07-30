import assert from "assert";

async function run(): Promise<void> {
  process.env.PLANE_API_KEY = process.env.PLANE_API_KEY || "test-plane-api-key";
  process.env.PLANE_PROJECT_ID = process.env.PLANE_PROJECT_ID || "test-plane-project";
  process.env.PLANE_WORKSPACE_SLUG = process.env.PLANE_WORKSPACE_SLUG || "test-plane-workspace";

  const { deletePlaneWorkItem } = await import("./services/planeDeletionService");
  const { PlaneWebhookService } = await import("./services/planeWebhookService");

  let requestedUrl = "";
  const deleted = await deletePlaneWorkItem(
    "00000000-0000-0000-0000-000000000123",
    {
      async delete(url: string) {
        requestedUrl = url;
        return { status: 204 } as any;
      },
    } as any
  );
  assert.strictEqual(deleted.deleted, true);
  assert.strictEqual(deleted.alreadyAbsent, false);
  assert.match(requestedUrl, /\/work-items\/00000000-0000-0000-0000-000000000123\/$/);

  const absent = await deletePlaneWorkItem(
    "00000000-0000-0000-0000-000000000404",
    {
      async delete() {
        throw { response: { status: 404 } };
      },
    } as any
  );
  assert.strictEqual(absent.deleted, false);
  assert.strictEqual(absent.alreadyAbsent, true);

  await assert.rejects(
    () =>
      deletePlaneWorkItem(
        "00000000-0000-0000-0000-000000000500",
        {
          async delete() {
            throw { response: { status: 500 } };
          },
        } as any
      ),
    (error: any) => error?.response?.status === 500
  );

  let deletedFromDatabase = "";
  const reverseSync = new PlaneWebhookService(
    {
      async listAllTickets() {
        return [{ planeIssueId: "00000000-0000-0000-0000-000000000404" }];
      },
      async deleteTicketFromPlane(planeIssueId: string) {
        deletedFromDatabase = planeIssueId;
        return true;
      },
    } as any,
    {
      async get() {
        throw { response: { status: 404 } };
      },
    } as any
  );
  const summary = await reverseSync.syncLinkedTicketsFromPlane();
  assert.strictEqual(deletedFromDatabase, "00000000-0000-0000-0000-000000000404");
  assert.deepStrictEqual(summary, {
    checked: 1,
    updated: 0,
    deleted: 1,
    unlinked: 0,
    failed: 0,
  });

  console.log("Plane bidirectional delete service tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
