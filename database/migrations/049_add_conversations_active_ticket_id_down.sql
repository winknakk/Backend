-- Rollback Migration 049
DROP INDEX IF EXISTS idx_conversations_active_ticket_id;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS fk_conversations_active_ticket;
ALTER TABLE conversations DROP COLUMN IF EXISTS active_ticket_id;
