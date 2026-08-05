import { pool } from "./adapters/postgres/PostgresAdapter";
import * as fs from "fs";
import * as path from "path";

async function applyMigrationV4() {
  console.log("Applying Migration 027 V4 Multi-Tenant Foundation to PostgreSQL database...");
  const sqlPath = path.resolve(__dirname, "../database/migrations/027_v4_multi_tenant_rls_foundation.sql");
  const sql = fs.readFileSync(sqlPath, "utf-8");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (version) VALUES ('027_v4_multi_tenant_rls_foundation.sql') ON CONFLICT (version) DO NOTHING"
    );
    await client.query("COMMIT");
    console.log("✅ Migration 027 V4 applied successfully to PostgreSQL database!");
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("❌ Migration V4 failed:", err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

applyMigrationV4();
