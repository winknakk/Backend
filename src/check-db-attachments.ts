import { pool } from "./adapters/postgres/PostgresAdapter";

async function checkDatabase() {
  try {
    const msgs = await pool.query("SELECT id, conversation_id, role, content, message_type FROM messages ORDER BY id DESC LIMIT 10");
    console.log("=== Recent Messages ===");
    console.table(msgs.rows);

    const atts = await pool.query("SELECT id, message_id, file_url, file_name, storage_key FROM message_attachments ORDER BY id DESC LIMIT 10");
    console.log("=== Recent Message Attachments ===");
    console.table(atts.rows);
  } catch (err: any) {
    console.error("DB Query Error:", err.message);
  } finally {
    await pool.end();
  }
}

checkDatabase();
