import { PostgresAdapter } from "../src/adapters/postgres/PostgresAdapter";

async function main() {
  const adapter = new PostgresAdapter();
  const { pool } = require("../src/adapters/postgres/PostgresAdapter");

  try {
    console.log("Seeding test conversation room for Task 2...");
    await pool.query("INSERT INTO companies (id, name) VALUES (999, 'Task2 Co') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO profiles (id, name, company_id) VALUES (999, 'Task2 User', 999) ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO identities (id, profile_id, channel, channel_ref) VALUES ('task2-ident', 999, 'LINE', 'task2-ref') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO conversations (id, identity_id, channel, status) VALUES (999, 'task2-ident', 'LINE', 'open') ON CONFLICT DO NOTHING");

    // Clean old tickets
    await pool.query("DELETE FROM tickets WHERE id IN ('TCK-TASK2-A', 'TCK-TASK2-B')");

    // Case A: projectId = "1" (parseable)
    console.log("Case A: Creating ticket TCK-TASK2-A with projectId = '1'...");
    const resA = await adapter.createTicket({
      conversationId: "999",
      subject: "SSO Fail",
      summary: "Zod fail",
      priority: "P2",
      severity: "High",
      projectId: "1",
    }, new Date().toISOString(), "TCK-TASK2-A");

    console.log("Case A Result success:", resA.success);
    const rowA = await pool.query("SELECT id, project_id FROM tickets WHERE id = 'TCK-TASK2-A'");
    console.log("DB Row A project_id:", rowA.rows[0]);

    // Case B: projectId = "p1" (unparseable)
    console.log("\nCase B: Creating ticket TCK-TASK2-B with projectId = 'p1'...");
    const resB = await adapter.createTicket({
      conversationId: "999",
      subject: "SSO Fail B",
      summary: "Zod fail B",
      priority: "P3",
      severity: "Medium",
      projectId: "p1",
    }, new Date().toISOString(), "TCK-TASK2-B");

    console.log("Case B Result success:", resB.success);
    const rowB = await pool.query("SELECT id, project_id FROM tickets WHERE id = 'TCK-TASK2-B'");
    console.log("DB Row B project_id:", rowB.rows[0]);

  } catch (err: any) {
    console.error("Test failed with error:", err.message);
  } finally {
    await pool.end();
  }
}

main();
