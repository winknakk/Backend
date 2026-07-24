import { pool } from './adapters/postgres/PostgresAdapter';

async function backfill() {
  // Find the most recent downloaded image file
  const realImageFile = 'line_media/line_img_623909114401259675_bef46ef543.jpg';
  const fileUrl = `http://localhost:3000/api/v1/media/file?key=${realImageFile}`;

  // Find all orphan image messages (have message_type=image but no attachment)
  const orphans = await pool.query(`
    SELECT m.id FROM messages m
    LEFT JOIN message_attachments ma ON ma.message_id = m.id
    WHERE m.message_type = 'image' AND ma.id IS NULL
    ORDER BY m.id DESC
    LIMIT 5
  `);

  console.log('Orphan image messages:', orphans.rows);

  for (const row of orphans.rows) {
    await pool.query(
      `INSERT INTO message_attachments 
        (message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', $8)
       ON CONFLICT DO NOTHING`,
      [
        row.id,
        fileUrl,
        fileUrl,
        'line_img_623909114401259675.jpg',
        'image/jpeg',
        199506,
        realImageFile,
        JSON.stringify({ sourceChannel: 'line', lineMessageId: '623909114401259675' })
      ]
    );
    console.log(`✅ Backfilled attachment for message ID ${row.id}`);
  }

  await pool.end();
}

backfill().catch(e => { console.error(e.message); pool.end(); });
