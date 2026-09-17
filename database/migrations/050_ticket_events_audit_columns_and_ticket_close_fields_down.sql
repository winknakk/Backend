-- Down for migration 050. Removes only what 050 added; the ticket_events table
-- itself is left in place because earlier code paths depend on it.
DROP INDEX IF EXISTS idx_ticket_events_ticket_type_created;
ALTER TABLE ticket_events DROP COLUMN IF EXISTS source;
ALTER TABLE ticket_events DROP COLUMN IF EXISTS correlation_id;
ALTER TABLE ticket_events DROP COLUMN IF EXISTS actor;
ALTER TABLE tickets DROP COLUMN IF EXISTS closed_at;
ALTER TABLE tickets DROP COLUMN IF EXISTS reopened_count;
