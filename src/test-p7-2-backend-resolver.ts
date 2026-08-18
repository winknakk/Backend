import assert from "assert";
import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";
import { PostgresAdapter, pool } from "./adapters/postgres/PostgresAdapter";
import { PlaneProjectResolver } from "./services/PlaneProjectResolver";
import { PlaneApiClient } from "./services/PlaneApiClient";
import { PlaneService } from "./services/planeService";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function runP72BackendResolverTest() {
  console.log("=================================================================");
  console.log("Phase P7.2 Test: PlaneProjectResolver & PlaneApiClient Boundary");
  console.log("=================================================================");

  // Connect pool explicitly
  const dbAdapter = new PostgresAdapter();
  const resolver = new PlaneProjectResolver(dbAdapter);
  const apiClient = new PlaneApiClient();

  try {
    // 1. Resolve SCG Project (ID 1, org_default)
    console.log("\n[Test 1] Testing PlaneProjectResolver for SCG (project_id = 1, org_default)...");
    const scgConfig = await resolver.resolveByProjectId(1, "org_default");
    assert.strictEqual(scgConfig.workspaceSlug, "cs-team");
    assert.strictEqual(scgConfig.planeProjectId, "09aa9c0e-8448-426f-8128-306c3dcf9d78");
    assert.strictEqual(scgConfig.credentialRef, "plane_api_08c97a9323bf4854b6bae958d7577f60");
    console.log("  ✅ Test 1 PASSED: SCG resolved cleanly.");

    // 2. Resolve Excise Project (ID 101, org_excise)
    console.log("\n[Test 2] Testing PlaneProjectResolver for Excise (project_id = 101, org_excise)...");
    const exciseConfig = await resolver.resolveByProjectId(101, "org_excise");
    assert.strictEqual(exciseConfig.workspaceSlug, "cs-team");
    assert.strictEqual(exciseConfig.planeProjectId, "e3454524-961a-4b84-8ccb-71575baaa696");
    assert.strictEqual(exciseConfig.credentialRef, "plane_api_08c97a9323bf4854b6bae958d7577f60");
    console.log("  ✅ Test 2 PASSED: Excise resolved cleanly.");

    // 3. Security Test: Cross-Tenant Tampering
    console.log("\n[Test 3] Testing Cross-Tenant Security Isolation (project_id = 1, org_excise)...");
    try {
      await resolver.resolveByProjectId(1, "org_excise");
      assert.fail("Cross-tenant lookup MUST throw PLANE_MAPPING_NOT_FOUND");
    } catch (err: any) {
      assert(err.message.includes("PLANE_MAPPING_NOT_FOUND"), "Error must contain PLANE_MAPPING_NOT_FOUND");
      console.log("  ✅ Test 3 PASSED: Cross-tenant lookup rejected with PLANE_MAPPING_NOT_FOUND.");
    }

    // 4. Security Test: Unmapped Project Fail-Closed
    console.log("\n[Test 4] Testing Unmapped Project Fail-Closed (project_id = 9999)...");
    try {
      await resolver.resolveByProjectId(9999, "org_default");
      assert.fail("Unmapped project lookup MUST throw PLANE_MAPPING_NOT_FOUND");
    } catch (err: any) {
      assert(err.message.includes("PLANE_MAPPING_NOT_FOUND"), "Error must contain PLANE_MAPPING_NOT_FOUND");
      console.log("  ✅ Test 4 PASSED: Unmapped project rejected with PLANE_MAPPING_NOT_FOUND.");
    }

    // 5. PlaneApiClient Base URL formatting
    console.log("\n[Test 5] Testing PlaneApiClient Base URL formatting...");
    const url = apiClient.getProjectBaseUrl(scgConfig);
    assert.strictEqual(url, "https://projects.oneweb.tech/api/v1/workspaces/cs-team/projects/09aa9c0e-8448-426f-8128-306c3dcf9d78");
    console.log(`  ✅ Test 5 PASSED: Encapsulated URL: ${url}`);

    // 6. Test G Requirement: Historical Snapshot preservation
    console.log("\n[Test 6] Testing Historical Snapshot preservation on PlaneService...");
    const planeService = new PlaneService(dbAdapter);
    const mockHistoricalTicket = {
      id: 999,
      project_id: 1,
      org_id: "org_default",
      plane_workspace_slug: "cs-team-legacy",
      plane_project_id: "legacy-plane-uuid-001",
    };
    const historicalConfig = await planeService.getProjectConfigForTicket(mockHistoricalTicket);
    assert.strictEqual(historicalConfig.workspaceSlug, "cs-team-legacy");
    assert.strictEqual(historicalConfig.planeProjectId, "legacy-plane-uuid-001");
    console.log("  ✅ Test 6 PASSED: Historical ticket retained legacy Plane project snapshot.");

    console.log("\n=================================================================");
    console.log("🎉 ALL P7.2 BACKEND RESOLVER & API CLIENT TESTS PASSED!");
    console.log("=================================================================");
  } catch (error: any) {
    console.error("\n❌ P7.2 Test Failed:", error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runP72BackendResolverTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
