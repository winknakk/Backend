import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pool } from "./adapters/postgres/PostgresAdapter";

async function main(): Promise<void> {
  const migrationPath = path.resolve(__dirname, "../database/migrations/030_line_project_onboarding.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    const result = await client.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = ANY(current_schemas(false))
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [["project_join_codes", "line_onboarding_sessions", "line_onboarding_requests", "line_webhook_events"]]
    );
    assert.deepEqual(
      result.rows.map((row) => row.table_name),
      ["line_onboarding_requests", "line_onboarding_sessions", "line_webhook_events", "project_join_codes"]
    );
    const projectResult = await client.query(
      `SELECT COUNT(*)::integer AS count FROM projects WHERE org_id IS NOT NULL`
    );
    assert.ok(projectResult.rows[0].count > 0, "runtime must contain at least one organization-scoped project");
    await client.query("ROLLBACK");
    process.stdout.write("LINE onboarding migration passed against the configured database and was rolled back.\n");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
