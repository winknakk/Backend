-- Migration 037 Down: Rollback complete message schema additions

DROP INDEX IF EXISTS idx_messages_conv_created;
DROP INDEX IF EXISTS idx_messages_reply_to_message_id;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_delivery_status_check,
  DROP CONSTRAINT IF EXISTS messages_reply_to_message_id_fkey,
  DROP COLUMN IF EXISTS quote_token,
  DROP COLUMN IF EXISTS is_pinned,
  DROP COLUMN IF EXISTS reactions,
  DROP COLUMN IF EXISTS delivery_status,
  DROP COLUMN IF EXISTS reply_to_message_id;
