import { pool } from "./adapters/postgres/PostgresAdapter";

async function check() {
  const projects = await pool.query("SELECT * FROM projects ORDER BY id ASC");
  console.log("=== PROJECTS ===");
  console.table(projects.rows);
  process.exit(0);
}

check();
