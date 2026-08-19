import { pool } from "./adapters/postgres/PostgresAdapter";
import axios from "axios";

async function run() {
  console.log("🚀 Starting 24/7 Plane Project Mapping Registration...");

  // 1. Inspect projects in database
  const projectsRes = await pool.query("SELECT id, name, org_id FROM projects ORDER BY id ASC");
  console.log("\n📋 Current Projects in DB:");
  console.table(projectsRes.rows);

  // Projects to map: ID 8 ('24/7') and ID 2 ('Customer Success Service')
  const targetProjectIds = [8, 2];

  for (const projId of targetProjectIds) {
    const proj = projectsRes.rows.find((p: any) => p.id === projId);
    const orgId = proj?.org_id || "org_default";
    const projName = proj?.name || `Project ${projId}`;

    console.log(`\n⚙️ Processing Mapping for Project ID ${projId} ("${projName}") under org "${orgId}"...`);

    // Check if existing mapping exists
    const checkRes = await pool.query(
      "SELECT id FROM plane_workspace_mappings WHERE project_id = $1 AND org_id = $2 LIMIT 1",
      [projId, orgId]
    );

    if (checkRes.rows.length > 0) {
      await pool.query(
        `UPDATE plane_workspace_mappings
         SET workspace_slug = $1,
             plane_project_id = $2,
             plane_api_key = $3,
             credential_ref = $4,
             plane_api_base_url = $5,
             enabled = TRUE,
             updated_at = NOW()
         WHERE id = $6`,
        [
          "ask-natapohn",
          "4e840554-dc75-4e39-b87d-db31d8bcc1c9",
          "plane_api_6d16b662f16343e090c345cc76f59b03",
          "plane_api_6d16b662f16343e090c345cc76f59b03",
          "https://api.plane.so",
          checkRes.rows[0].id
        ]
      );
      console.log(`  ✅ Updated existing mapping (ID: ${checkRes.rows[0].id}) for Project ${projId}`);
    } else {
      const insertRes = await pool.query(
        `INSERT INTO plane_workspace_mappings (
           org_id, project_id, workspace_slug, plane_project_id,
           plane_api_key, credential_ref, plane_api_base_url, enabled, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NOW(), NOW())
         RETURNING id`,
        [
          orgId,
          projId,
          "ask-natapohn",
          "4e840554-dc75-4e39-b87d-db31d8bcc1c9",
          "plane_api_6d16b662f16343e090c345cc76f59b03",
          "plane_api_6d16b662f16343e090c345cc76f59b03",
          "https://api.plane.so"
        ]
      );
      console.log(`  ✅ Inserted new mapping (ID: ${insertRes.rows[0].id}) for Project ${projId}`);
    }
  }

  // Show all current mappings
  const allMappings = await pool.query("SELECT id, org_id, project_id, workspace_slug, plane_project_id, plane_api_base_url, enabled FROM plane_workspace_mappings ORDER BY id ASC");
  console.log("\n📋 All Current Plane Workspace Mappings:");
  console.table(allMappings.rows);

  // 3. Test Plane.so API live connection
  console.log("\n🌐 Verifying Plane.so live API connection for workspace 'ask-natapohn' (Project 4e840554-dc75-4e39-b87d-db31d8bcc1c9)...");
  try {
    const testUrl = "https://api.plane.so/api/v1/workspaces/ask-natapohn/projects/4e840554-dc75-4e39-b87d-db31d8bcc1c9/";
    const apiRes = await axios.get(testUrl, {
      headers: {
        "x-api-key": "plane_api_6d16b662f16343e090c345cc76f59b03"
      }
    });
    console.log("  ✅ Plane API Connection OK:", {
      id: apiRes.data.id,
      name: apiRes.data.name,
      identifier: apiRes.data.identifier
    });
  } catch (err: any) {
    console.log("  ⚠️ Plane API test status:", err.response?.status, err.response?.data || err.message);
  }

  console.log("\n🎉 Setup Completed Successfully!");
  process.exit(0);
}

run().catch((e) => {
  console.error("❌ Error executing setup:", e);
  process.exit(1);
});
