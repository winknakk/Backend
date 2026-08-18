import * as fs from "fs";
import * as path from "path";
import { Client } from "pg";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function applyMigration034() {
  console.log("Connecting directly to PostgreSQL...");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
  });

  await client.connect();
  console.log("Connected to PostgreSQL. Executing Migration 034...");

  try {
    const sqlPath = path.resolve(__dirname, "../database/migrations/034_plane_project_mappings.sql");
    const sql = fs.readFileSync(sqlPath, "utf-8");
    await client.query(sql);
    console.log("✅ Migration 034 executed successfully.");
  } finally {
    await client.end();
  }
}

applyMigration034()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migration 034 failed:", err);
    process.exit(1);
  });
