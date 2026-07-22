import { pool } from './adapters/postgres/PostgresAdapter';

async function migrate() {
  console.log('Running Release 1.0 Non-Breaking Database Schema Additions...');

  await pool.query(`
    -- 1. Add reply_to_message_id for Quoted Reply relational links
    ALTER TABLE messages 
    ADD COLUMN IF NOT EXISTS reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;

    -- 2. Add message delivery status tracking
    ALTER TABLE messages 
    ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(20) DEFAULT 'delivered' 
    CHECK (delivery_status IN ('sending', 'sent', 'delivered', 'failed'));

    -- 3. Add reactions & pinning support
    ALTER TABLE messages 
    ADD COLUMN IF NOT EXISTS reactions JSONB DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;

    -- 4. Create index for quoted parent lookups
    CREATE INDEX IF NOT EXISTS idx_messages_reply_parent ON messages(reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;
  `);

  console.log('✅ Release 1.0 Non-Breaking Schema Migration Completed Successfully!');
  await pool.end();
}

migrate().catch(e => { console.error('Migration failed:', e); pool.end(); });
