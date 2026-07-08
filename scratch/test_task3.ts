import { PostgresAdapter } from "../src/adapters/postgres/PostgresAdapter";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const adapter = new PostgresAdapter();
  const { pool } = require("../src/adapters/postgres/PostgresAdapter");

  try {
    console.log("Seeding test conversation room for Task 3...");
    await pool.query("INSERT INTO companies (id, name) VALUES (999, 'Task3 Co') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO profiles (id, name, company_id) VALUES (999, 'Task3 User', 999) ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO identities (id, profile_id, channel, channel_ref) VALUES ('task3-ident', 999, 'LINE', 'task3-ref') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO conversations (id, identity_id, channel, status) VALUES (999, 'task3-ident', 'LINE', 'open') ON CONFLICT DO NOTHING");

    // Clean old tickets
    await pool.query("DELETE FROM tickets WHERE id IN ('TCK-TASK3-1', 'TCK-TASK3-2')");

    console.log("Creating Ticket 1 (TCK-TASK3-1)...");
    await adapter.createTicket({
      conversationId: "999",
      subject: "SSO Ticket 1",
      summary: "First ticket description",
      priority: "P2",
      severity: "High",
      projectId: "1",
    }, new Date(Date.now() + 12 * 3600 * 1000).toISOString(), "TCK-TASK3-1");

    console.log("Waiting 3 seconds...");
    await delay(3000);

    console.log("Creating Ticket 2 (TCK-TASK3-2)...");
    await adapter.createTicket({
      conversationId: "999",
      subject: "SSO Ticket 2",
      summary: "Second ticket description",
      priority: "P1",
      severity: "Critical",
      projectId: "1",
    }, new Date(Date.now() + 4 * 3600 * 1000).toISOString(), "TCK-TASK3-2");

    console.log("\n--- First Query (Immediate) ---");
    const list1 = await adapter.listAllTickets("999");
    const t1_first = list1.find(t => t.id === "TCK-TASK3-1");
    const t2_first = list1.find(t => t.id === "TCK-TASK3-2");

    console.log("Ticket 1 - CreatedAt:", t1_first?.createdAt, "DueDate:", t1_first?.dueDate);
    console.log("Ticket 2 - CreatedAt:", t2_first?.createdAt, "DueDate:", t2_first?.dueDate);

    console.log("Waiting 5 seconds before next query...");
    await delay(5000);

    console.log("\n--- Second Query (After 5 seconds) ---");
    const list2 = await adapter.listAllTickets("999");
    const t1_second = list2.find(t => t.id === "TCK-TASK3-1");
    const t2_second = list2.find(t => t.id === "TCK-TASK3-2");

    console.log("Ticket 1 - CreatedAt:", t1_second?.createdAt, "DueDate:", t1_second?.dueDate);
    console.log("Ticket 2 - CreatedAt:", t2_second?.createdAt, "DueDate:", t2_second?.dueDate);

    // Verify stability
    const t1_createdAt_stable = t1_first?.createdAt === t1_second?.createdAt;
    const t1_dueDate_stable = t1_first?.dueDate === t1_second?.dueDate;
    const t2_createdAt_stable = t2_first?.createdAt === t2_second?.createdAt;
    const t2_dueDate_stable = t2_first?.dueDate === t2_second?.dueDate;

    console.log("\n=== Stability Verification ===");
    console.log("Ticket 1 CreatedAt Stable:", t1_createdAt_stable);
    console.log("Ticket 1 DueDate Stable:", t1_dueDate_stable);
    console.log("Ticket 2 CreatedAt Stable:", t2_createdAt_stable);
    console.log("Ticket 2 DueDate Stable:", t2_dueDate_stable);

    if (t1_createdAt_stable && t1_dueDate_stable && t2_createdAt_stable && t2_dueDate_stable) {
      console.log("🎉 SUCCESS: Ticket SLA due_date and createdAt are completely stable!");
    } else {
      console.error("❌ FAILURE: SLA due_date or createdAt shifted between queries!");
    }

  } catch (err: any) {
    console.error("Test failed with error:", err.message);
  } finally {
    await pool.end();
  }
}

main();
