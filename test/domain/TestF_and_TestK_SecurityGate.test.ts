import Fastify from "fastify";
import { registerAdminPlaneIntegrationRoutes } from "../../src/api/routes/adminPlaneIntegrationRoutes";
import { PlaneAdminService } from "../../src/services/PlaneAdminService";
import { pool } from "../../src/adapters/postgres/PostgresAdapter";
import assert from "assert";

async function runFinalSecurityGate() {
  console.log("==================================================================");
  console.log("🔒 FINAL SECURITY GATE: Evidence Test for Test F & Test K");
  console.log("==================================================================");

  // Setup test Fastify instance with admin routes registered
  const app = Fastify();
  await app.register(registerAdminPlaneIntegrationRoutes);
  await app.ready();

  const service = new PlaneAdminService();

  try {
    // 0. Prepare database tenants and projects
    await pool.query(`
      INSERT INTO organizations (id, name, slug, status, created_at, updated_at)
      VALUES 
        ('org_alpha', 'Alpha Corp', 'alpha', 'active', NOW(), NOW()),
        ('org_beta', 'Beta Corp', 'beta', 'active', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO projects (id, name, company_id, org_id, created_at, updated_at)
      VALUES 
        (401, 'Alpha Finance System', 1, 'org_alpha', NOW(), NOW()),
        (402, 'Beta Logistics System', 1, 'org_beta', NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET org_id = EXCLUDED.org_id, name = EXCLUDED.name;

      DELETE FROM plane_workspace_mappings WHERE project_id IN (401, 402);
    `);

    // =========================================================================
    // 🛡️ TEST F: UNAUTHORIZED ADMIN MATRIX (4 SUB-CASES)
    // =========================================================================
    console.log("\n[Test F.1] Case 1: No Authentication Header / Non-admin role (Customer)...");
    const resCustomer = await app.inject({
      method: "GET",
      url: "/api/v1/admin/plane-integrations",
      headers: {
        "x-user-role": "customer",
        "x-org-id": "org_alpha",
      },
    });
    console.log(`  -> Status: ${resCustomer.statusCode}, Body: ${resCustomer.body}`);
    assert.strictEqual(resCustomer.statusCode, 403, "Customer must receive 403 Forbidden");
    console.log("  ✅ Test F.1 PASSED: Customer received 403 Forbidden.");

    console.log("\n[Test F.2] Case 2: Employee (Non-Admin Internal User)...");
    const resEmployee = await app.inject({
      method: "GET",
      url: "/api/v1/admin/plane-integrations",
      headers: {
        "x-user-role": "employee",
        "x-org-id": "org_alpha",
      },
    });
    console.log(`  -> Status: ${resEmployee.statusCode}, Body: ${resEmployee.body}`);
    assert.strictEqual(resEmployee.statusCode, 403, "Employee must receive 403 Forbidden");
    console.log("  ✅ Test F.2 PASSED: Employee received 403 Forbidden.");

    console.log("\n[Test F.3] Case 3: Admin from different org (Tenant Boundary Violation)...");
    // Admin of org_beta tries to create mapping for Project 401 (which belongs to org_alpha)
    const resCrossTenant = await app.inject({
      method: "POST",
      url: "/api/v1/admin/projects/401/plane-integration",
      headers: {
        "x-user-role": "admin",
        "x-org-id": "org_beta", // Mismatched tenant
      },
      payload: {
        workspaceSlug: "malicious-ws",
        planeProjectId: "malicious-proj-id",
        credential: { type: "plane_api_key", secret: "secret_hack" },
      },
    });
    console.log(`  -> Status: ${resCrossTenant.statusCode}, Body: ${resCrossTenant.body}`);
    assert(
      resCrossTenant.statusCode === 500 || resCrossTenant.statusCode === 403,
      "Cross-tenant admin request must be rejected"
    );
    const bodyObj = JSON.parse(resCrossTenant.body);
    assert(
      bodyObj.message.includes("Unauthorized: Project belongs to org_alpha"),
      "Must reject with tenant mismatch error"
    );
    console.log("  ✅ Test F.3 PASSED: Cross-tenant admin mutation strictly rejected.");

    console.log("\n[Test F.4] Case 4: Authorized Org Admin (Valid Tenant & Role)...");
    const resValidAdmin = await app.inject({
      method: "GET",
      url: "/api/v1/admin/plane-integrations",
      headers: {
        "x-user-role": "admin",
        "x-org-id": "org_alpha",
      },
    });
    console.log(`  -> Status: ${resValidAdmin.statusCode}, Body: length ${JSON.parse(resValidAdmin.body).mappings.length}`);
    assert.strictEqual(resValidAdmin.statusCode, 200, "Valid admin must receive 200 OK");
    console.log("  ✅ Test F.4 PASSED: Valid admin authorized successfully.");

    // =========================================================================
    // ⚡ TEST K: CONCURRENT MAPPING CREATION & PG UNIQUE INDEX INTEGRITY
    // =========================================================================
    console.log("\n[Test K] Concurrent Race Condition: Two Admins POST mapping for Project 401 simultaneously...");

    // Fire 2 concurrent HTTP POST requests to create mapping on Project 401 at the exact same moment
    const [req1, req2] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/admin/projects/401/plane-integration",
        headers: { "x-user-role": "admin", "x-org-id": "org_alpha" },
        payload: {
          workspaceSlug: "alpha-concurrent-ws-1",
          planeProjectId: "proj-concurrent-1",
          credential: { type: "plane_api_key", secret: "secret_concurrent_1" },
        },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/admin/projects/401/plane-integration",
        headers: { "x-user-role": "admin", "x-org-id": "org_alpha" },
        payload: {
          workspaceSlug: "alpha-concurrent-ws-2",
          planeProjectId: "proj-concurrent-2",
          credential: { type: "plane_api_key", secret: "secret_concurrent_2" },
        },
      }),
    ]);

    const statuses = [req1.statusCode, req2.statusCode];
    console.log(`  -> Request A Status: ${req1.statusCode} (${req1.body})`);
    console.log(`  -> Request B Status: ${req2.statusCode} (${req2.body})`);

    // Verify: Exactly one succeeded (201) and the other was rejected with 409 Conflict
    assert(statuses.includes(201), "One concurrent request must succeed with 201 Created");
    assert(statuses.includes(409), "The competing concurrent request must be rejected with 409 Conflict");

    // Verify database state: Exactly 1 row in plane_workspace_mappings for Project 401
    const countCheck = await pool.query(`
      SELECT count(*) as total_active 
      FROM plane_workspace_mappings 
      WHERE project_id = 401 AND enabled = TRUE AND archived_at IS NULL
    `);
    const totalActive = parseInt(countCheck.rows[0].total_active, 10);
    console.log(`  -> Active rows in database for Project 401: ${totalActive}`);
    assert.strictEqual(totalActive, 1, "Database must enforce EXACTLY ONE active mapping per project");
    console.log("  ✅ Test K PASSED: Concurrency race condition correctly handled (1 succeeded, 1 got 409 Conflict, DB has exactly 1 active mapping).");

    console.log("\n==================================================================");
    console.log("🏆 FINAL SECURITY GATE PASSED: Tests F & K 100% Verified!");
    console.log("==================================================================");
  } finally {
    await app.close();
    await pool.query(`DELETE FROM plane_workspace_mappings WHERE project_id IN (401, 402)`);
    await pool.query(`DELETE FROM projects WHERE id IN (401, 402)`);
  }
}

runFinalSecurityGate().then(() => process.exit(0)).catch((err) => {
  console.error("❌ Final Security Gate Failed:", err);
  process.exit(1);
});
