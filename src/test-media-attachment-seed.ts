import { pool } from "./adapters/postgres/PostgresAdapter";

async function seedTestAttachment() {
  try {
    console.log("=== Checking current conversations ===");
    const convRes = await pool.query("SELECT id FROM conversations ORDER BY id DESC LIMIT 1");
    if (convRes.rows.length === 0) {
      console.log("No conversations found.");
      return;
    }

    const conversationId = convRes.rows[0].id;
    console.log(`Using latest Conversation ID: ${conversationId}`);

    // Insert a test image message into messages table
    const msgRes = await pool.query(
      `INSERT INTO messages (conversation_id, role, content, message_type, message_purpose, created_at)
       VALUES ($1, 'customer', '', 'image', 'reply', NOW())
       RETURNING id`,
      [conversationId]
    );

    const messageId = msgRes.rows[0].id;
    console.log(`Created test image message ID: ${messageId}`);

    // Insert attachment record into message_attachments table
    const attRes = await pool.query(
      `INSERT INTO message_attachments 
        (message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata)
       VALUES 
        ($1, $2, $3, $4, $5, $6, $7, 'READY', $8)
       RETURNING id`,
      [
        messageId,
        "http://localhost:3000/api/v1/media/file?key=test_sample.png",
        "http://localhost:3000/api/v1/media/file?key=test_sample.png",
        "sample_image.png",
        "image/png",
        102400,
        "test_sample.png",
        JSON.stringify({ source: "manual_test_seed" })
      ]
    );

    console.log(`Successfully created test attachment ID: ${attRes.rows[0].id}`);
  } catch (err: any) {
    console.error("Failed to seed test attachment:", err.message);
  } finally {
    await pool.end();
  }
}

seedTestAttachment();
