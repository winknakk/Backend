const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function main() {
  try {
    const res = await pool.query(
      `SELECT id, role, content, to_char(created_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS') as time_bkk
       FROM messages
       WHERE conversation_id = 99961
         AND created_at >= '2026-09-18 13:45:00+07'
         AND created_at <= '2026-09-18 14:15:00+07'
       ORDER BY id`
    );
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

main();
