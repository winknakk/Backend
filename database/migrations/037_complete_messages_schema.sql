-- Migration 037: Complete message schema for production runtime
-- Purpose: Ensure reply_to_message_id, delivery_status, reactions, is_pinned, and quote_token exist idempotently on messages table.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(20) DEFAULT 'delivered',
  ADD COLUMN IF NOT EXISTS reactions JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS quote_token TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'messages'::regclass
      AND conname = 'messages_reply_to_message_id_fkey'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_reply_to_message_id_fkey
      FOREIGN KEY (reply_to_message_id)
      REFERENCES messages(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'messages'::regclass
      AND conname = 'messages_delivery_status_check'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_delivery_status_check
      CHECK (delivery_status IN ('sending', 'sent', 'delivered', 'failed'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_messages_reply_to_message_id
  ON messages (reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_conv_created
  ON messages (conversation_id, created_at ASC);
