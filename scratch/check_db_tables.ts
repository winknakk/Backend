import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();
    console.log("Connected to PostgreSQL successfully.\n");
    const tables = [
      "messages",
      "message_attachments",
      "conversations",
      "tickets",
      "ticket_events",
      "ticket_summaries",
      "identities",
      "profiles",
      "companies",
      "customer_project_memberships",
      "line_onboarding_sessions",
      "agent_session_queue",
      "agent_session_state",
      "execution_contexts",
      "execution_traces",
      "outbox_events",
      "customer_notifications",
      "projects",
      "operators",
      "plane_workspace_mappings"
    ];

    for (const t of tables) {
      try {
        const res = await client.query(`SELECT COUNT(*)::int as count FROM ${t}`);
        console.log(`${t.padEnd(32)}: ${res.rows[0].count} rows`);
      } catch (e: any) {
        console.log(`${t.padEnd(32)}: [Error: ${e.message}]`);
      }
    }
  } catch (err: any) {
    console.error("Connection error:", err.message);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
