import { pool } from "./adapters/postgres/PostgresAdapter";

async function attachSampleToEmptyMessages() {
  try {
    console.log("=== Finding empty image messages in DB ===");
    const res = await pool.query(
      `SELECT id, conversation_id FROM messages WHERE (content = '' OR content IS NULL OR message_type = 'image') ORDER BY id ASC`
    );

    console.log(`Found ${res.rows.length} empty or image messages.`);

    for (const row of res.rows) {
      // Check if attachment exists
      const attCheck = await pool.query("SELECT id FROM message_attachments WHERE message_id = $1", [row.id]);
      if (attCheck.rows.length === 0) {
        console.log(`Adding attachment record to Message ID ${row.id}...`);
        await pool.query(
          `UPDATE messages SET message_type = 'image' WHERE id = $1`,
          [row.id]
        );
        await pool.query(
          `INSERT INTO message_attachments 
            (message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata)
           VALUES 
            ($1, $2, $3, $4, $5, $6, $7, 'READY', $8)`,
          [
            row.id,
            "http://localhost:3000/api/v1/media/file?key=test_sample.png",
            "http://localhost:3000/api/v1/media/file?key=test_sample.png",
            `line_image_${row.id}.jpg`,
            "image/jpeg",
            204800,
            `line_media/line_img_${row.id}.jpg`,
            JSON.stringify({ source: "auto_backfill" })
          ]
        );
      }
    }

    console.log("✅ All empty image messages successfully backfilled with attachments!");
  } catch (err: any) {
    console.error("Backfill failed:", err.message);
  } finally {
    await pool.end();
  }
}

attachSampleToEmptyMessages();
