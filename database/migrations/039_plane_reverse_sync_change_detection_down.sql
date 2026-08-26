-- Rollback for migration 039.
DROP INDEX IF EXISTS idx_tickets_plane_linkage;
ALTER TABLE tickets DROP COLUMN IF EXISTS plane_last_seen_updated_at;
