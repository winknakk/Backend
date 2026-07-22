import { pool } from "./adapters/postgres/PostgresAdapter";
import fs from "fs";
import path from "path";

async function runMigration() {
  try {
    const migrationPath = path.join(__dirname, "../database/migrations(win)/006_media_attachment_metadata.sql");
    console.log("Reading migration from:", migrationPath);
    
    const sql = fs.readFileSync(migrationPath, "utf-8");
    console.log("Executing Migration 006 against PostgreSQL...");

    await pool.query(sql);
    console.log("✅ Migration 006_media_attachment_metadata.sql executed successfully!");
  } catch (err: any) {
    console.error("❌ Migration failed:", err.message);
  } finally {
    await pool.end();
  }
}

runMigration();
