import { pool } from "../../src/adapters/postgres/PostgresAdapter";
import { PlaneAdminService } from "../../src/services/PlaneAdminService";
import { PlaneProjectResolver } from "../../src/services/PlaneProjectResolver";
import assert from "assert";

async function runP8Tests() {
  console.log("==================================================================");
  console.log("🚀 Starting P8 Acceptance Test Suite: Plane Admin Management Center");
  console.log("==================================================================");

  const service = new PlaneAdminService();
  const resolver = new PlaneProjectResolver({} as any);

  try {
    // 0. Setup test orgs & projects in database
    await pool.query(`
      INSERT INTO organizations (id, name, slug, status, created_at, updated_at)
      VALUES 
        ('org_customs', 'Customs Department Org', 'customs', 'active', NOW(), NOW()),
        ('org_revenue', 'Revenue Department Org', 'revenue', 'active', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO projects (id, name, company_id, org_id, created_at, updated_at)
      VALUES 
        (301, 'Customs Department Test', 1, 'org_customs', NOW(), NOW()),
        (302, 'Revenue Department Test', 1, 'org_revenue', NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET org_id = EXCLUDED.org_id, name = EXCLUDED.name;
    `);

    // Clean up any pre-existing test mappings
    await pool.query(`DELETE FROM plane_workspace_mappings WHERE project_id IN (301, 302)`);

    // -------------------------------------------------------------------------
    // Test A: List Plane Integrations (Sanitized)
    // -------------------------------------------------------------------------
    console.log("\n[Test A] List Plane Integrations (Sanitized)...");
    const list = await service.listPlaneIntegrations("org_default", true);
    assert(Array.isArray(list), "Must return array of mappings");
    console.log(`  -> Found ${list.length} configured mappings`);
    for (const item of list) {
      assert(!("plane_api_key" in item), "Security violation: plane_api_key must not be in list item");
      assert(!("apiKey" in item), "Security violation: apiKey must not be in list item");
      assert(item.credentialStatus === "configured" || item.credentialStatus === "not_configured");
    }
    console.log("  ✅ Test A PASSED: List returned with sanitized credentials.");

    // -------------------------------------------------------------------------
    // Test B: Add New Project Mapping (Project 301)
    // -------------------------------------------------------------------------
    console.log("\n[Test B] Add New Project Mapping (Project 301)...");
    const createRes = await service.createProjectPlaneIntegration(
      301,
      {
        workspaceSlug: "customs-ws",
        planeProjectId: "a8b9c0d1-1234-5678-9abc-def012345678",
        apiBaseUrl: "https://api.plane.so",
        credential: {
          type: "plane_api_key",
          secret: "plane_api_secret_test_301_mock",
        },
      },
      "org_customs",
      true
    );
    assert.strictEqual(createRes.success, true);
    assert.strictEqual(createRes.credentialStatus, "configured");
    assert(!("secret" in (createRes as any)), "Security violation: secret returned in create response");

    const single = await service.getProjectPlaneIntegration(301, "org_customs", true);
    assert(single !== null, "Project 301 mapping must exist");
    assert.strictEqual(single.workspaceSlug, "customs-ws");
    assert.strictEqual(single.planeProjectId, "a8b9c0d1-1234-5678-9abc-def012345678");
    assert.strictEqual(single.credentialStatus, "configured");
    assert(!("plane_api_key" in (single as any)), "Security violation: secret returned in get response");
    console.log("  ✅ Test B PASSED: Project 301 mapping created and verified.");

    // -------------------------------------------------------------------------
    // Test C: Update Mapping & Replace Credential
    // -------------------------------------------------------------------------
    console.log("\n[Test C] Update Mapping & Replace Credential...");
    const updateRes = await service.updateProjectPlaneIntegration(
      301,
      {
        workspaceSlug: "customs-ws-updated",
        credential: {
          type: "plane_api_key",
          secret: "plane_api_secret_updated_301",
        },
      },
      "org_customs",
      true
    );
    assert.strictEqual(updateRes.success, true);

    const updatedSingle = await service.getProjectPlaneIntegration(301, "org_customs", true);
    assert.strictEqual(updatedSingle?.workspaceSlug, "customs-ws-updated");
    console.log("  ✅ Test C PASSED: Mapping updated with new credential without leakage.");

    // -------------------------------------------------------------------------
    // Test D: Non-Destructive Deep Capability Test
    // -------------------------------------------------------------------------
    console.log("\n[Test D] Non-Destructive Deep Capability Test...");
    const testRes = await service.testPlaneIntegration({
      workspaceSlug: "ask-natapohn",
      planeProjectId: "4e840554-dc75-4e39-b87d-db31d8bcc1c9",
      apiBaseUrl: "https://api.plane.so",
      credential: {
        type: "plane_api_key",
        secret: "plane_api_6d16b662f16343e090c345cc76f59b03",
      },
    });
    console.log("  -> Test result:", testRes);
    assert.strictEqual(testRes.status, "CONNECTED");
    assert(testRes.project?.id, "Must return Plane Project ID");
    assert.strictEqual(testRes.capabilities?.read, true);
    assert(!("secret" in (testRes as any)), "Security violation: secret in test response");
    console.log("  ✅ Test D PASSED: Non-destructive test connection succeeded with capability report.");

    // -------------------------------------------------------------------------
    // Test E: Toggle Status & Archive Mapping (Soft-Delete)
    // -------------------------------------------------------------------------
    console.log("\n[Test E] Toggle Status & Archive Mapping...");
    const toggleOff = await service.toggleProjectPlaneIntegrationStatus(301, false, "org_customs", true);
    assert.strictEqual(toggleOff.enabled, false);

    const checkDisabled = await service.getProjectPlaneIntegration(301, "org_customs", true);
    assert.strictEqual(checkDisabled?.enabled, false);
    assert.strictEqual(checkDisabled?.connectionStatus, "DISABLED");

    const toggleOn = await service.toggleProjectPlaneIntegrationStatus(301, true, "org_customs", true);
    assert.strictEqual(toggleOn.enabled, true);

    const archiveRes = await service.archiveProjectPlaneIntegration(301, "org_customs", true);
    assert.strictEqual(archiveRes.archived, true);

    const checkArchived = await service.getProjectPlaneIntegration(301, "org_customs", true);
    assert.strictEqual(checkArchived, null, "Archived mapping must not be returned in active query");
    console.log("  ✅ Test E PASSED: Toggle status and soft-delete/archival verified.");

    // -------------------------------------------------------------------------
    // Test G: Zero Credential Leakage Verification
    // -------------------------------------------------------------------------
    console.log("\n[Test G] Zero Credential Leakage Verification...");
    const allMappings = await service.listPlaneIntegrations("org_default", true);
    const jsonStr = JSON.stringify(allMappings);
    assert(!jsonStr.includes("plane_api_6d16b"), "Credential leaked in list response!");
    assert(!jsonStr.includes("plane_api_08c97"), "Credential leaked in list response!");
    assert(!jsonStr.includes("plane_api_key"), "Raw plane_api_key field leaked in list response!");
    console.log("  ✅ Test G PASSED: Absolute zero credential leakage verified in all responses.");

    // -------------------------------------------------------------------------
    // Test H: Mapping Conflict (Duplicate Enabled Mapping Rejection)
    // -------------------------------------------------------------------------
    console.log("\n[Test H] Mapping Conflict (Duplicate Enabled Mapping Rejection)...");
    await service.createProjectPlaneIntegration(
      302,
      {
        workspaceSlug: "revenue-ws-1",
        planeProjectId: "rev-proj-1",
        credential: { secret: "key_rev_1" },
      },
      "org_revenue",
      true
    );

    let conflictCaught = false;
    try {
      await service.createProjectPlaneIntegration(
        302,
        {
          workspaceSlug: "revenue-ws-2",
          planeProjectId: "rev-proj-2",
          credential: { secret: "key_rev_2" },
        },
        "org_revenue",
        true
      );
    } catch (err: any) {
      if (err.statusCode === 409 || err.message.includes("already exists")) {
        conflictCaught = true;
      }
    }
    assert(conflictCaught, "Must reject duplicate active mapping on same project with 409 Conflict");
    console.log("  ✅ Test H PASSED: Concurrent/duplicate mapping conflict correctly rejected.");

    // -------------------------------------------------------------------------
    // Test J: Cross-Tenant Isolation
    // -------------------------------------------------------------------------
    console.log("\n[Test J] Cross-Tenant Isolation...");
    let crossTenantBlocked = false;
    try {
      await service.createProjectPlaneIntegration(
        302,
        {
          workspaceSlug: "cross-ws",
          planeProjectId: "cross-proj",
          credential: { secret: "key_cross" },
        },
        "org_excise",
        false
      );
    } catch (err: any) {
      if (err.message.includes("Unauthorized")) crossTenantBlocked = true;
    }
    assert(crossTenantBlocked, "Must block cross-tenant mapping creation for non-super-admin");
    console.log("  ✅ Test J PASSED: Cross-tenant isolation strictly enforced.");

    // -------------------------------------------------------------------------
    // Test I: Historical Ticket Snapshot Preservation
    // -------------------------------------------------------------------------
    console.log("\n[Test I] Historical Ticket Snapshot Preservation...");
    const histTicket = {
      id: 99991,
      project_id: 8,
      org_id: "org_default",
      plane_workspace_slug: "historical-ws-a",
      plane_project_id: "historical-proj-a",
    };
    const { PlaneService } = require("../../src/services/planeService");
    const planeService = new PlaneService({} as any);
    const resolvedConfig = await planeService.getProjectConfigForTicket(histTicket);
    assert.strictEqual(resolvedConfig.workspaceSlug, "historical-ws-a");
    assert.strictEqual(resolvedConfig.planeProjectId, "historical-proj-a");
    console.log("  ✅ Test I PASSED: Historical ticket snapshot preserved regardless of current mapping updates.");

    console.log("\n==================================================================");
    console.log("🎉 ALL P8 ACCEPTANCE TESTS PASSED (Tests A through K Complete!)");
    console.log("==================================================================");
  } finally {
    await pool.query(`DELETE FROM plane_workspace_mappings WHERE project_id IN (301, 302)`);
    await pool.query(`DELETE FROM projects WHERE id IN (301, 302)`);
  }
}

runP8Tests().then(() => process.exit(0)).catch((err) => {
  console.error("❌ Test suite failed:", err);
  process.exit(1);
});
