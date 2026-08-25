import { pool } from "../adapters/postgres/PostgresAdapter";
import { PlaneService } from "../services/planeService";
import { PostgresAdapter } from "../adapters/postgres/PostgresAdapter";

async function fixAndTestPlane() {
  await pool.query(
    "UPDATE plane_workspace_mappings SET credential_ref = $1, plane_api_key = $1 WHERE project_id = 101",
    ["plane_api_08c97a9323bf4854b6bae958d7577f60"]
  );
  console.log("Updated plane_workspace_mappings for project 101 (EXC03)");

  const mapping = await pool.query("SELECT * FROM plane_workspace_mappings WHERE project_id = 101");
  console.log("CURRENT MAPPING:", mapping.rows[0]);

  const dbAdapter = new PostgresAdapter();
  const planeService = new PlaneService(dbAdapter);

  const testPayload = {
    ticket_number: "TCK-2026-TEST-" + Math.floor(1000 + Math.random() * 9000),
    project_id: 101,
    org_id: "org_excise",
    subject: "ทดสอบการเปิด Ticket สรรพสามิต ไปยัง Plane",
    summary: "ทดสอบการส่ง Issue จาก TicketX ไปยัง https://projects.oneweb.tech/cs-team/projects/95c2f51f-16c9-4048-87e2-4a28a414a979",
    priority: "P2",
    severity: "High",
    created_by_type: "AI_BOT",
    created_by_name: "PromptX AI",
  };

  console.log("\nTesting promoteTicketToPlane for EXC03...");
  const result = await planeService.promoteTicketToPlane(testPayload);
  console.log("PROMOTION RESULT:", JSON.stringify(result, null, 2));

  await pool.end();
}

fixAndTestPlane().catch(console.error);
