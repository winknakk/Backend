import { pool } from "./adapters/postgres/PostgresAdapter";

async function check() {
  console.log("--- Checking messages for Conversation 11 ---");
  const { rows } = await pool.query(
    `SELECT id, role, content, message_type, external_id, reply_to_message_id, created_at 
     FROM messages 
     WHERE conversation_id = '11' 
     ORDER BY id DESC LIMIT 10`
  );
  console.log(JSON.stringify(rows, null, 2));
  await pool.end();
}

check().catch(console.error);
