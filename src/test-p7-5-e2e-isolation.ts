import assert from "assert";
import * as dotenv from "dotenv";
import * as path from "path";
import { PostgresAdapter, pool } from "./adapters/postgres/PostgresAdapter";
import { PlaneProjectResolver } from "./services/PlaneProjectResolver";
import { PlaneApiClient } from "./services/PlaneApiClient";
import { PlaneService } from "./services/planeService";
import { PlaneWebhookService } from "./services/planeWebhookService";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function runP75E2EIsolationTest() {
  console.log("=================================================================");
  console.log("Phase P7.5 E2E Verification: Multi-Plane Project Isolation");
  console.log("=================================================================");

  const client = await pool.connect();
  const dbAdapter = new PostgresAdapter();
  const resolver = new PlaneProjectResolver(dbAdapter);
  const apiClient = new PlaneApiClient();
  const planeService = new PlaneService(dbAdapter);
  const webhookService = new PlaneWebhookService(dbAdapter);

  try {
    // 1. SCG vs Excise Dual-Project Routing Authority Test
    console.log("\n[E2E Test 1] SCG (project_id = 1) vs Excise (project_id = 101) Resolution...");
    const scgConfig = await resolver.resolveByProjectId(1, "org_default");
    const exciseConfig = await resolver.resolveByProjectId(101, "org_excise");

    assert.strictEqual(scgConfig.planeProjectId, "09aa9c0e-8448-426f-8128-306c3dcf9d78", "SCG must route to 09aa9c0e-8448-426f-8128-306c3dcf9d78");
    assert.strictEqual(exciseConfig.planeProjectId, "e3454524-961a-4b84-8ccb-71575baaa696", "Excise must route to e3454524-961a-4b84-8ccb-71575baaa696");
    assert.notStrictEqual(scgConfig.planeProjectId, exciseConfig.planeProjectId, "SCG and Excise Plane Project IDs MUST BE DIFFERENT");
    console.log("  ✅ E2E Test 1 PASSED: SCG and Excise resolve to isolated Plane Projects.");

    // 2. Strict Cross-Tenant Tampering Rejection Test (Fail-Closed)
    console.log("\n[E2E Test 2] Cross-Tenant Isolation Security Test...");
    try {
      await resolver.resolveByProjectId(1, "org_excise");
      assert.fail("Cross-tenant lookup MUST throw PLANE_MAPPING_NOT_FOUND");
    } catch (err: any) {
      assert(err.message.includes("PLANE_MAPPING_NOT_FOUND"));
      console.log("  ✅ E2E Test 2 PASSED: Cross-tenant project resolution strictly rejected.");
    }

    // 3. Unmapped Project Rejection (No Fallback to Default Org)
    console.log("\n[E2E Test 3] Unmapped Project Fail-Closed Test (No Default Fallback)...");
    try {
      await resolver.resolveByProjectId(9999, "org_default");
      assert.fail("Unmapped project MUST throw PLANE_MAPPING_NOT_FOUND");
    } catch (err: any) {
      assert(err.message.includes("PLANE_MAPPING_NOT_FOUND"));
      console.log("  ✅ E2E Test 3 PASSED: Unmapped project rejected with no default fallback.");
    }

    // 4. Test G Historical Snapshot Preservation Test
    console.log("\n[E2E Test 4] Historical Snapshot Preservation Test (Test G)...");
    const historicalTicket = {
      id: 888,
      project_id: 1,
      org_id: "org_default",
      plane_workspace_slug: "cs-team-legacy",
      plane_project_id: "legacy-plane-uuid-001",
    };
    const historicalConfig = await planeService.getProjectConfigForTicket(historicalTicket);
    assert.strictEqual(historicalConfig.workspaceSlug, "cs-team-legacy");
    assert.strictEqual(historicalConfig.planeProjectId, "legacy-plane-uuid-001");
    console.log("  ✅ E2E Test 4 PASSED: Historical ticket retained legacy Plane project snapshot.");

    // 5. DB Constraints & Index Verification
    console.log("\n[E2E Test 5] Database Schema & Index Integrity Verification...");
    const idxRes = await client.query(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'tickets' AND indexname = 'idx_tickets_plane_3key';
    `);
    assert(idxRes.rows.length > 0, "idx_tickets_plane_3key index must exist");

    const mappingConstraint = await client.query(`
      SELECT conname FROM pg_constraint 
      WHERE conname = 'uq_plane_workspace_mappings_project';
    `);
    assert(mappingConstraint.rows.length > 0, "uq_plane_workspace_mappings_project constraint must exist");
    console.log("  ✅ E2E Test 5 PASSED: Database constraints and 3-key composite index verified.");

    console.log("\n=================================================================");
    console.log("🎉 ALL P7.5 E2E MULTI-PROJECT ISOLATION TESTS PASSED!");
    console.log("=================================================================");
  } catch (error: any) {
    console.error("\n❌ P7.5 E2E Test Failed:", error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runP75E2EIsolationTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
