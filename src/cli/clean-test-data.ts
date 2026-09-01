import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

async function cleanTestData() {
  console.log("=================================================================");
  console.log("  TicketX Database: Clean Test & Transactional Data");
  console.log("=================================================================");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("❌ ERROR: DATABASE_URL is not defined in .env");
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 15000,
  });

  try {
    console.log("Connecting to database...");
    await client.connect();
    console.log("✅ Connected to PostgreSQL database.\n");

    // 1. Transactional and customer data tables to clear in cascade-safe order
    const tablesToClean = [
      "message_attachments",
      "messages",
      "customer_notifications",
      "ticket_events",
      "ticket_summaries",
      "tickets",
      "conversations",
      "line_onboarding_sessions",
      "customer_project_memberships",
      "identities",
      "agent_session_queue",
      "agent_session_state",
      "execution_traces",
      "execution_contexts",
      "outbox_events",
      "admin_audit_logs",
    ];

    console.log("🧹 Clearing transactional test data from tables...");
    for (const table of tablesToClean) {
      try {
        const result = await client.query(`TRUNCATE TABLE ${table} CASCADE;`);
        console.log(`  ✅ Cleared table: ${table}`);
      } catch (err: any) {
        // If TRUNCATE CASCADE fails or table does not exist, try DELETE
        try {
          await client.query(`DELETE FROM ${table};`);
          console.log(`  ✅ Cleared (DELETE): ${table}`);
        } catch (delErr: any) {
          console.warn(`  ⚠️  Skipped ${table} (${delErr.message})`);
        }
      }
    }

    // 2. Reset sequences for clean IDs starting from 1
    console.log("\n🔄 Resetting auto-increment sequences...");
    const sequencesToReset = [
      "conversations_id_seq",
      "messages_id_seq",
      "tickets_id_seq",
      "identities_id_seq",
      "message_attachments_id_seq",
      "agent_session_queue_id_seq",
      "ticket_events_id_seq",
      "outbox_events_id_seq",
      "customer_project_memberships_id_seq",
      "line_onboarding_sessions_id_seq",
    ];

    for (const seq of sequencesToReset) {
      try {
        await client.query(`ALTER SEQUENCE ${seq} RESTART WITH 1;`);
        console.log(`  ✅ Reset sequence: ${seq}`);
      } catch (seqErr: any) {
        // Some sequences might not exist depending on schema version
      }
    }

    // 3. Clear local file backups / cache
    console.log("\n📁 Cleaning local file backup caches...");
    const backupDir = path.resolve(__dirname, "../../data/backups");
    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir);
      for (const file of files) {
        if (file.endsWith(".json.enc") || file.endsWith(".json")) {
          fs.unlinkSync(path.join(backupDir, file));
          console.log(`  ✅ Deleted backup cache: ${file}`);
        }
      }
    }

    console.log("\n=================================================================");
    console.log("🎉 All test, chat, conversation, and ticket data cleared successfully!");
    console.log("   (Master data, Projects, SLA Policies, and Knowledge Base preserved)");
    console.log("=================================================================");
  } catch (err: any) {
    console.error("\n❌ Error during database cleanup:", err.message);
  } finally {
    await client.end().catch(() => {});
  }
}

cleanTestData();
