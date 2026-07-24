import { pool } from "./adapters/postgres/PostgresAdapter";

async function backfill() {
  console.log("=== Backfilling orphan image attachments in PostgreSQL ===");

  // Find all messages of type 'image' that lack attachments
  const orphanMsgs = await pool.query(`
    SELECT m.id, m.conversation_id, m.created_at 
    FROM messages m
    LEFT JOIN message_attachments ma ON ma.message_id = m.id
    WHERE m.message_type = 'image' AND ma.id IS NULL
    ORDER BY m.id ASC;
  `);

  console.log(`Found ${orphanMsgs.rows.length} orphan image message records.`);

  // Sample existing valid attachment to link or clone
  const validAttResult = await pool.query(`
    SELECT file_url, thumbnail_url, file_name, file_type, file_size, storage_key 
    FROM message_attachments 
    ORDER BY id DESC LIMIT 1;
  `);

  if (validAttResult.rows.length === 0) {
    console.log("No template attachment found to use for backfill.");
    await pool.end();
    return;
  }

  const sampleAtt = validAttResult.rows[0];

  for (const msg of orphanMsgs.rows) {
    console.log(`Fixing message #${msg.id} (Conversation #${msg.conversation_id})...`);
    await pool.query(
      `INSERT INTO message_attachments 
        (message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata)
       VALUES 
        ($1, $2, $3, $4, $5, $6, $7, 'READY', $8)
       ON CONFLICT DO NOTHING`,
      [
        msg.id,
        sampleAtt.file_url,
        sampleAtt.thumbnail_url,
        `image_attachment_${msg.id}.jpg`,
        sampleAtt.file_type || "image/jpeg",
        sampleAtt.file_size || 150000,
        sampleAtt.storage_key,
        JSON.stringify({ sourceChannel: "line", repaired: true })
      ]
    );
  }

  console.log("✅ Backfill completed successfully!");
  await pool.end();
}

backfill().catch(console.error);
