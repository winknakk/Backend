import { pool } from "./adapters/postgres/PostgresAdapter";

async function inspect() {
  console.log("=== 1. Messages Table Schema ===");
  const msgCols = await pool.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'messages'
    ORDER BY ordinal_position;
  `);
  console.log(msgCols.rows);

  console.log("\n=== 2. Message Attachments Table Schema ===");
  const attCols = await pool.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'message_attachments'
    ORDER BY ordinal_position;
  `);
  console.log(attCols.rows);

  console.log("\n=== 3. Recent Messages ===");
  const recentMsgs = await pool.query(`
    SELECT id, conversation_id, role, content, message_type, external_id, reply_to_message_id, quote_token, created_at 
    FROM messages 
    ORDER BY id DESC LIMIT 10;
  `);
  console.log(recentMsgs.rows);

  console.log("\n=== 4. Recent Attachments ===");
  const recentAtts = await pool.query(`
    SELECT * FROM message_attachments ORDER BY id DESC LIMIT 10;
  `);
  console.log(recentAtts.rows);

  await pool.end();
}

inspect().catch(console.error);
