-- Migration 013: Add external_id column and composite unique constraint for multi-channel idempotency
ALTER TABLE messages ADD COLUMN IF NOT EXISTS external_id VARCHAR(255);
ALTER TABLE messages DROP CONSTRAINT IF EXISTS unique_channel_external_id;
ALTER TABLE messages ADD CONSTRAINT unique_channel_external_id UNIQUE (conversation_id, external_id);
