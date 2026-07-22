import { pool } from './adapters/postgres/PostgresAdapter';

async function fix81() {
  const fileName = 'line_img_623910534139347081_56a005991b.jpg';
  const storageKey = `line_media/${fileName}`;
  const fileUrl = `http://localhost:3000/api/v1/media/file?key=${storageKey}`;

  await pool.query(
    `INSERT INTO message_attachments 
      (message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', $8)
     ON CONFLICT DO NOTHING`,
    [
      81,
      fileUrl,
      fileUrl,
      fileName,
      'image/jpeg',
      149235,
      storageKey,
      JSON.stringify({ sourceChannel: 'line' })
    ]
  );
  console.log('✅ Linked msg 81 to', fileName);
  await pool.end();
}
fix81().catch(e => console.error(e));
