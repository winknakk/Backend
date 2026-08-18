import assert from "assert";
import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function runP71DatabaseMappingTest() {
  console.log("=================================================================");
  console.log("Phase P7.1 DB Test: Multi-Plane Project Mapping & DB Isolation");
  console.log("=================================================================");

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
  });

  await client.connect();
  try {
    // 1. Verify Migration 034 applied / Table exists
    console.log("\n[Test 1] Verifying plane_workspace_mappings schema...");
    const tableCheck = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'plane_workspace_mappings';
    `);
    assert(tableCheck.rows.length > 0, "plane_workspace_mappings table must exist");
    
    const columns = tableCheck.rows.map((r: any) => r.column_name);
    assert(columns.includes("project_id"), "column 'project_id' must exist");
    assert(columns.includes("workspace_slug"), "column 'workspace_slug' must exist");
    assert(columns.includes("plane_project_id"), "column 'plane_project_id' must exist");
    assert(columns.includes("credential_ref"), "column 'credential_ref' must exist");
    assert(columns.includes("enabled"), "column 'enabled' must exist");
    console.log("  ✅ Test 1 PASSED: plane_workspace_mappings schema verified.");

    // 2. Verify Ticket snapshot columns
    console.log("\n[Test 2] Verifying tickets table snapshot columns...");
    const ticketCheck = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'tickets' AND column_name IN ('plane_workspace_slug', 'plane_project_id');
    `);
    const ticketCols = ticketCheck.rows.map((r: any) => r.column_name);
    assert(ticketCols.includes("plane_workspace_slug"), "tickets.plane_workspace_slug must exist");
    assert(ticketCols.includes("plane_project_id"), "tickets.plane_project_id must exist");
    console.log("  ✅ Test 2 PASSED: tickets snapshot columns verified.");

    // 3. Test SCG Project (ID 1) Mapping Query
    console.log("\n[Test 3] Querying SCG Project (project_id = 1) mapping...");
    const scgRes = await client.query(`
      SELECT workspace_slug, plane_project_id, credential_ref 
      FROM plane_workspace_mappings 
      WHERE project_id = 1 AND org_id = 'org_default' AND enabled = TRUE;
    `);
    assert(scgRes.rows.length === 1, "SCG project mapping must exist");
    assert.strictEqual(scgRes.rows[0].plane_project_id, "09aa9c0e-8448-426f-8128-306c3dcf9d78");
    assert.strictEqual(scgRes.rows[0].workspace_slug, "cs-team");
    console.log(`  ✅ Test 3 PASSED: SCG mapped to Plane Project ${scgRes.rows[0].plane_project_id}`);

    // 4. Test Excise Project (ID 101) Mapping Query
    console.log("\n[Test 4] Querying Excise Project (project_id = 101) mapping...");
    const exciseRes = await client.query(`
      SELECT workspace_slug, plane_project_id, credential_ref 
      FROM plane_workspace_mappings 
      WHERE project_id = 101 AND org_id = 'org_excise' AND enabled = TRUE;
    `);
    assert(exciseRes.rows.length === 1, "Excise project mapping must exist");
    assert.strictEqual(exciseRes.rows[0].plane_project_id, "e3454524-961a-4b84-8ccb-71575baaa696");
    assert.strictEqual(exciseRes.rows[0].workspace_slug, "cs-team");
    console.log(`  ✅ Test 4 PASSED: Excise mapped to Plane Project ${exciseRes.rows[0].plane_project_id}`);

    // 5. Test Tenant Security Isolation (Cross-Tenant Tampering Prevention)
    console.log("\n[Test 5] Security Test: Querying project_id = 1 with WRONG org_id = 'org_excise'...");
    const tamperRes = await client.query(`
      SELECT plane_project_id 
      FROM plane_workspace_mappings 
      WHERE project_id = 1 AND org_id = 'org_excise' AND enabled = TRUE;
    `);
    assert.strictEqual(tamperRes.rows.length, 0, "Cross-tenant query MUST return 0 rows (Fail-Closed)");
    console.log("  ✅ Test 5 PASSED: Cross-tenant project lookup strictly rejected (0 rows returned).");

    // 6. Test Unmapped Project (Fail-Closed)
    console.log("\n[Test 6] Security Test: Querying unmapped project_id = 9999...");
    const unmappedRes = await client.query(`
      SELECT plane_project_id 
      FROM plane_workspace_mappings 
      WHERE project_id = 9999 AND org_id = 'org_default' AND enabled = TRUE;
    `);
    assert.strictEqual(unmappedRes.rows.length, 0, "Unmapped project query MUST return 0 rows (Fail-Closed)");
    console.log("  ✅ Test 6 PASSED: Unmapped project strictly rejected (0 rows returned).");

    console.log("\n=================================================================");
    console.log("🎉 ALL P7.1 DATABASE MAPPING TESTS PASSED SUCCESSFULLY!");
    console.log("=================================================================");
  } catch (error: any) {
    console.error("\n❌ P7.1 DB Test Failed:", error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runP71DatabaseMappingTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
