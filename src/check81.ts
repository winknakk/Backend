import { pool } from './adapters/postgres/PostgresAdapter';

async function check81() {
  const r = await pool.query(`
    SELECT m.id, m.conversation_id, m.role, m.content, m.message_type, m.created_at,
           ma.id as att_id, ma.file_url, ma.file_name
    FROM messages m
    LEFT JOIN message_attachments ma ON ma.message_id = m.id
    WHERE m.id >= 77
    ORDER BY m.id DESC
  `);
  console.log(JSON.stringify(r.rows, null, 2));
  await pool.end();
}
check81().catch(e => console.error(e));
