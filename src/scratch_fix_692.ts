import { pool } from './adapters/postgres/PostgresAdapter';
import { LINEAdapter } from './presentation/http/adapters/LINEAdapter';
import { S3MediaStorageService } from './media/services/S3MediaStorageService';
import { config } from './config/env';

async function fix692() {
  const lineToken = (config.LINE_CHANNEL_ACCESS_TOKEN || '').trim();
  const mediaStorage = new S3MediaStorageService({});
  const adapter = new LINEAdapter(mediaStorage, lineToken);

  console.log('Downloading LINE content for message 626227117445349820...');
  const lineEvent = {
    type: 'message',
    message: { type: 'image', id: '626227117445349820' },
    source: { userId: 'Ue3575daf4967d84d3a634bf55a06881c' },
    timestamp: Date.now()
  };

  const normalized = await adapter.adaptEvent(lineEvent);
  if (normalized && normalized.attachments.length > 0) {
    const att = normalized.attachments[0];
    console.log('Downloaded attachment:', att);

    await pool.query("UPDATE messages SET message_type = 'image' WHERE id = 692");
    await pool.query(
      `INSERT INTO message_attachments 
        (message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata)
       VALUES 
        ($1, $2, $3, $4, $5, $6, $7, 'READY', $8)
       ON CONFLICT DO NOTHING`,
      [
        692,
        att.fileUrl,
        att.thumbnailUrl || att.fileUrl,
        att.fileName,
        att.fileType,
        att.fileSize,
        att.storageKey,
        JSON.stringify({ sourceChannel: 'line', lineImageId: '626227117445349820' })
      ]
    );
    console.log('SUCCESS: Attachment attached to message 692!');
  } else {
    console.error('FAILED to download image from LINE');
  }
  await pool.end();
}

fix692().catch(console.error);
