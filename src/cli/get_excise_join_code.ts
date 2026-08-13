import { pool } from "../adapters/postgres/PostgresAdapter";

async function checkCodes() {
  const client = await pool.connect();
  try {
    const res = await client.query(`SELECT id, project_id, org_id, status, expires_at FROM project_join_codes WHERE project_id = 101`);
    console.log("=== Join Codes for Project 101 ===");
    console.log(JSON.stringify(res.rows, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

checkCodes().catch(console.error);
