-- Migration 049: Add active_ticket_id to conversations table
-- Purpose: Persist canonical customer active ticket focus pointer without mutating conversation project_id

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS active_ticket_id INTEGER NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'conversations'::regclass
      AND conname = 'fk_conversations_active_ticket'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT fk_conversations_active_ticket
      FOREIGN KEY (active_ticket_id)
      REFERENCES tickets(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_conversations_active_ticket_id
  ON conversations (active_ticket_id)
  WHERE active_ticket_id IS NOT NULL;
