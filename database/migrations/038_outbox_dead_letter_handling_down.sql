-- Rollback for migration 038.
-- Returns dead-lettered events to the legacy 'failed' status and drops the
-- columns and indexes added by the forward migration.

UPDATE outbox_events
SET status = 'failed'
WHERE status = 'dead_letter';

DROP INDEX IF EXISTS idx_outbox_events_due;
DROP INDEX IF EXISTS idx_outbox_events_dead_letter;

ALTER TABLE outbox_events
  DROP COLUMN IF EXISTS failure_kind,
  DROP COLUMN IF EXISTS next_attempt_at,
  DROP COLUMN IF EXISTS dead_lettered_at;
