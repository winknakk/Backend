import { pool } from './adapters/postgres/PostgresAdapter';

async function check81Details() {
  const r = await pool.query(`SELECT * FROM messages WHERE id = 81`);
  console.log(r.rows);
  await pool.end();
}
check81Details().catch(e => console.error(e));
