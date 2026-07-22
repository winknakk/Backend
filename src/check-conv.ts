import { pool } from './adapters/postgres/PostgresAdapter';

async function check() {
  // Get all latest image messages
  const r = await pool.query(`
    SELECT m.id, m.conversation_id, m.role, m.message_type, m.created_at,
           ma.id as att_id, ma.file_url, ma.file_name, ma.storage_key
    FROM messages m
    LEFT JOIN message_attachments ma ON ma.message_id = m.id
    WHERE m.message_type = 'image'
    ORDER BY m.id DESC
    LIMIT 10
  `);
  console.log('Latest image messages:\n', JSON.stringify(r.rows, null, 2));

  // Also check admin route - what conversations exist
  const convs = await pool.query(`
    SELECT id, identity_id, status, channel FROM conversations ORDER BY id DESC LIMIT 10
  `);
  console.log('\nConversations:\n', JSON.stringify(convs.rows, null, 2));

  await pool.end();
}
check().catch(e => { console.error(e.message); pool.end(); });
