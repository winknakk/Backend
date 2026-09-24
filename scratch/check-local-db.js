const { Pool } = require('pg');

async function testLocal() {
  const pool = new Pool({
    connectionString: 'postgresql://postgres:564241@localhost:5432/Ticket PostgreSQL'
  });
  try {
    const res = await pool.query('SELECT count(*), max(id) FROM tickets');
    console.log('Local DB (Ticket PostgreSQL) count & max_id:', res.rows[0]);
    const latest = await pool.query('SELECT id, ticket_number, created_at, subject, plane_issue_id FROM tickets ORDER BY id DESC LIMIT 5');
    console.log('Local DB Latest 5:', latest.rows);
  } catch (err) {
    console.error('Local DB Error:', err.message);
  } finally {
    await pool.end();
  }
}

testLocal();
