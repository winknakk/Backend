-- ============================================================
-- AutomationX V3 - Add created_at column to tickets table
-- 006_add_tickets_created_at.sql
-- ============================================================

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- Backfill old rows that don't have a value
UPDATE tickets SET created_at = NOW() WHERE created_at IS NULL;
