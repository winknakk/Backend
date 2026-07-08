import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    console.log("=== PROJECTS IN DATABASE ===");
    const resProjects = await client.query("SELECT id, name, company_id FROM projects ORDER BY id");
    console.table(resProjects.rows);

    console.log("\n=== IDENTITIES IN DATABASE ===");
    const resIdentities = await client.query("SELECT id, profile_id, channel, channel_ref FROM identities ORDER BY id");
    console.table(resIdentities.rows);

    console.log("\n=== SLA POLICIES FOR PROJECT 11 & 12 ===");
    const resSla = await client.query("SELECT project_id, priority, resolve_hours, response_hours, service_window FROM project_sla_policies WHERE project_id IN (11, 12) ORDER BY project_id, priority");
    console.table(resSla.rows);

  } catch (err: any) {
    console.error("Error:", err.message);
  } finally {
    await client.end();
  }
}

run();
