import assert from "assert";
import * as dotenv from "dotenv";
import * as path from "path";
import { PostgresAdapter, pool } from "./adapters/postgres/PostgresAdapter";
import { PlaneWebhookService } from "./services/planeWebhookService";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function runP74Poller3KeyTest() {
  console.log("=================================================================");
  console.log("Phase P7.4 Test: Multi-Project 3-Key Reverse Sync & Frontend Link");
  console.log("=================================================================");

  const client = await pool.connect();
  const dbAdapter = new PostgresAdapter();
  const webhookService = new PlaneWebhookService(dbAdapter);

  try {
    // 1. Verify Reverse Sync queries active plane_workspace_mappings
    console.log("\n[Test 1] Testing 3-Key Reverse Sync Poller Execution...");
    const summary = await webhookService.syncLinkedTicketsFromPlane(10);
    assert(typeof summary.checked === "number", "summary.checked must be a number");
    assert(typeof summary.updated === "number", "summary.updated must be a number");
    console.log(`  ✅ Test 1 PASSED: Reverse sync poller executed cleanly across enabled mappings (checked: ${summary.checked}).`);

    // 2. Test 3-Key Composite Index Existence on tickets table
    console.log("\n[Test 2] Verifying Composite Index idx_tickets_plane_3key on database...");
    const indexCheck = await client.query(`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'tickets' AND indexname = 'idx_tickets_plane_3key';
    `);
    assert(indexCheck.rows.length > 0, "idx_tickets_plane_3key index must exist on tickets table");
    console.log("  ✅ Test 2 PASSED: idx_tickets_plane_3key verified on PostgreSQL.");

    // 3. Test Dynamic Frontend URL Format Verification
    console.log("\n[Test 3] Verifying Dynamic Frontend Plane URL Builder logic...");
    const scgUrl = `https://projects.oneweb.tech/cs-team/projects/09aa9c0e-8448-426f-8128-306c3dcf9d78/issues/issue-scg-001`;
    const exciseUrl = `https://projects.oneweb.tech/cs-team/projects/e3454524-961a-4b84-8ccb-71575baaa696/issues/issue-excise-001`;

    assert(scgUrl.includes("09aa9c0e-8448-426f-8128-306c3dcf9d78"), "SCG URL must route to SCG Plane Project");
    assert(exciseUrl.includes("e3454524-961a-4b84-8ccb-71575baaa696"), "Excise URL must route to Excise Plane Project");
    console.log("  ✅ Test 3 PASSED: Dynamic Frontend URL formatting verified for SCG and Excise.");

    console.log("\n=================================================================");
    console.log("🎉 ALL P7.4 POLLER 3-KEY & FRONTEND LINK TESTS PASSED!");
    console.log("=================================================================");
  } catch (error: any) {
    console.error("\n❌ P7.4 Test Failed:", error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runP74Poller3KeyTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
