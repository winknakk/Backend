import { config } from "../src/config/env";
// Clear webhooks to force fallback to direct db adapter update
config.ACTIVEPIECES_PROMOTE_TICKET_WEBHOOK_URL = "";
config.ACTIVEPIECES_PROMOTE_TICKET_WEBHOOK_URL_V2 = "";

import { PostgresAdapter } from "../src/adapters/postgres/PostgresAdapter";
import { PlaneService } from "../src/services/planeService";

async function main() {
  const adapter = new PostgresAdapter();
  const planeService = new PlaneService(adapter);

  try {
    console.log("Seeding test data for Task 1 (Fallback Mode)...");
    const { pool } = require("../src/adapters/postgres/PostgresAdapter");
    
    await pool.query("INSERT INTO companies (id, name) VALUES (999, 'Task1 Co') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO profiles (id, name, company_id) VALUES (999, 'Task1 User', 999) ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO identities (id, profile_id, channel, channel_ref) VALUES ('task1-ident', 999, 'LINE', 'task1-ref') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO conversations (id, identity_id, channel, status) VALUES (999, 'task1-ident', 'LINE', 'open') ON CONFLICT DO NOTHING");
    
    // Create ticket and make sure plane_issue_id is NULL
    await pool.query("DELETE FROM tickets WHERE id = 'TCK-TASK1'");
    await pool.query(`
      INSERT INTO tickets (id, conversation_id, subject, summary, status, priority, created_via)
      VALUES ('TCK-TASK1', 999, 'SSO Issue', 'Cannot login to SSO', 'Open', 'P1', 'ai')
    `);

    console.log("Calling PlaneService.promoteTicketToPlane('TCK-TASK1')... (should run direct update)");
    const result = await planeService.promoteTicketToPlane("TCK-TASK1");
    console.log("Result:", result);

    // Verify it updated the DB with VARCHAR plane_issue_id
    const { rows } = await pool.query("SELECT id, plane_issue_id, status FROM tickets WHERE id = 'TCK-TASK1'");
    console.log("Updated Ticket DB Row:", rows[0]);

  } catch (err: any) {
    console.error("Test failed with error:", err.message);
  } finally {
    const { pool } = require("../src/adapters/postgres/PostgresAdapter");
    await pool.end();
  }
}

main();
