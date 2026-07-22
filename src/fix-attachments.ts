import { pool } from './adapters/postgres/PostgresAdapter';

async function fixAttachments() {
  // Get all image messages ordered by id to understand the timeline
  const msgs = await pool.query(`
    SELECT m.id, m.conversation_id, m.created_at, ma.id as att_id, ma.file_url, ma.storage_key
    FROM messages m
    LEFT JOIN message_attachments ma ON ma.message_id = m.id
    WHERE m.message_type = 'image'
    ORDER BY m.id DESC
    LIMIT 20
  `);

  console.log('Current image messages:');
  msgs.rows.forEach(r => console.log(`  msg ${r.id} | att_id ${r.att_id} | ${r.storage_key || 'NO ATT'}`));

  // Real files on disk ordered by download time (= order of LINE messages)
  const realFiles = [
    { name: 'line_img_623909114401259675_bef46ef543.jpg', size: 199506 },
    { name: 'line_img_623909759401591279_503d59b6f7.jpg', size: 113619 },
    { name: 'line_img_623909829446205548_610e4d2644.jpg', size: 18009 },
  ];

  // Get last N image messages (matching count of real files) ordered ASC (oldest first)
  const orphanMsgs = await pool.query(`
    SELECT m.id FROM messages m
    WHERE m.message_type = 'image'
    ORDER BY m.id DESC
    LIMIT $1
  `, [realFiles.length]);

  // Reverse so oldest message = oldest file
  const msgsAsc = orphanMsgs.rows.reverse();

  console.log('\nMapping:');
  for (let i = 0; i < Math.min(msgsAsc.length, realFiles.length); i++) {
    const msgId = msgsAsc[i].id;
    const file = realFiles[i];
    const storageKey = `line_media/${file.name}`;
    const fileUrl = `http://localhost:3000/api/v1/media/file?key=${storageKey}`;

    // Delete old wrong attachment if exists
    await pool.query(`DELETE FROM message_attachments WHERE message_id = $1`, [msgId]);

    // Insert correct attachment
    await pool.query(
      `INSERT INTO message_attachments 
        (message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', $8)`,
      [
        msgId,
        fileUrl,
        fileUrl,
        file.name,
        'image/jpeg',
        file.size,
        storageKey,
        JSON.stringify({ sourceChannel: 'line' })
      ]
    );
    console.log(`  ✅ msg ${msgId} → ${file.name}`);
  }

  // Verify
  console.log('\nVerification:');
  const verify = await pool.query(`
    SELECT m.id, ma.file_url, ma.file_name
    FROM messages m
    JOIN message_attachments ma ON ma.message_id = m.id
    WHERE m.message_type = 'image'
    ORDER BY m.id DESC
    LIMIT 10
  `);
  verify.rows.forEach(r => console.log(`  msg ${r.id} → ${r.file_name}`));

  await pool.end();
}

fixAttachments().catch(e => { console.error(e.message); pool.end(); });
