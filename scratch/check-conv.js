const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function main() {
  try {
    const res = await pool.query('SELECT id, project_id, org_id FROM cs_tickets.conversations ORDER BY id DESC LIMIT 5');
    console.log('Recent conversations:', res.rows);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

main();
