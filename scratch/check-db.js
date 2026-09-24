const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function main() {
  try {
    const schemas = await pool.query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = 'tickets'");
    console.log('Schemas with tickets table:', schemas.rows);
    for (const row of schemas.rows) {
      const res = await pool.query(`SELECT count(*), max(id) FROM ${row.table_schema}.tickets`);
      console.log(`Schema: ${row.table_schema} -> count: ${res.rows[0].count}, max_id: ${res.rows[0].max}`);
      const latest = await pool.query(`SELECT id, ticket_number, created_at, subject, plane_issue_id FROM ${row.table_schema}.tickets ORDER BY id DESC LIMIT 5`);
      console.log(`Latest 5 in ${row.table_schema}:`, latest.rows);
    }
  } catch (err) {
    console.error('DB Error:', err);
  } finally {
    await pool.end();
  }
}

main();
