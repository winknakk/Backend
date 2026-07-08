import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    console.log("=== SCHEMA MIGRATIONS ===");
    const resMigrations = await client.query("SELECT * FROM schema_migrations ORDER BY version");
    console.table(resMigrations.rows);

    console.log("\n=== PROJECT SLA POLICIES COLUMNS ===");
    const resColumns = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'project_sla_policies'
    `);
    console.table(resColumns.rows);

  } catch (err: any) {
    console.error("Error:", err.message);
  } finally {
    await client.end();
  }
}

run();
