-- Migration 038: Outbox dead-letter handling and retry scheduling
--
-- Problem this addresses:
--   Failed outbox events were retried five times and then abandoned in a
--   'failed' status that nothing surfaced. Eleven events sat unnoticed for
--   19 days, nine of them permanently unprocessable ("Custom Id cannot be
--   integers" from Plane, for tickets that no longer exist). Retrying them
--   could never have succeeded, and nothing distinguished them from a
--   transient outage.
--
-- Adds:
--   failure_kind      why an event stopped: transient / permanent / blocked
--   next_attempt_at   when a transient failure may be retried (backoff)
--   dead_lettered_at  when the event was given up on
--
-- Status vocabulary after this migration:
--   pending      awaiting dispatch (respects next_attempt_at)
--   processed    dispatched successfully
--   dead_letter  no longer retried automatically; needs operator attention

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS failure_kind VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ NULL;

-- The polling loop selects pending events that are due, oldest first.
-- Previously only `status` was indexed, so every cycle sorted the table.
CREATE INDEX IF NOT EXISTS idx_outbox_events_due
  ON outbox_events (status, next_attempt_at NULLS FIRST, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_outbox_events_dead_letter
  ON outbox_events (dead_lettered_at DESC)
  WHERE status = 'dead_letter';

-- Migrate the existing abandoned events. They are classified by their
-- recorded error rather than blanket-retried:
--   "Custom Id cannot be integers" - Plane rejected the payload itself, and
--     the tickets it referenced have since been deleted. Permanent.
--   403 - credentials or workspace permissions. Needs an operator, not a
--     retry loop against Plane.
UPDATE outbox_events
SET status = 'dead_letter',
    dead_lettered_at = COALESCE(updated_at, NOW()),
    failure_kind = CASE
      WHEN error_message ILIKE '%Custom Id cannot be integers%' THEN 'permanent'
      WHEN error_message ILIKE '%status code 401%'
        OR error_message ILIKE '%status code 403%' THEN 'blocked'
      ELSE 'transient'
    END
WHERE status = 'failed';
