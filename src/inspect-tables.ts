import { pool } from "./adapters/postgres/PostgresAdapter";

async function inspectAllSchemas() {
  const res = await pool.query(
    "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'pg_catalog') ORDER BY table_schema, table_name"
  );
  console.log("All tables across schemas:");
  console.log(res.rows.map((r) => `${r.table_schema}.${r.table_name}`));

  await pool.end();
}

inspectAllSchemas();
