-- Rollback for migration 040 (two-layer ticket status).
--
-- Collapses the two layers back into the single Plane-vocabulary column that
-- migrations 023/024 produced. The customer-lifecycle distinctions that Plane
-- cannot express (WAITING_CUSTOMER, CUSTOMER_CONFIRMED, REOPENED) are lost by
-- definition — that is what rolling back this design means.

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_status_lifecycle_check;
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_plane_status_check;

-- Prefer the recorded Plane state; fall back to deriving it from the
-- lifecycle for rows written before plane_status was populated.
UPDATE tickets
SET status = COALESCE(
  plane_status,
  CASE status
    WHEN 'NEW'                THEN 'Backlog'
    WHEN 'TRIAGED'            THEN 'Backlog'
    WHEN 'OPEN'               THEN 'Open'
    WHEN 'IN_PROGRESS'        THEN 'Open'
    WHEN 'WAITING_CUSTOMER'   THEN 'Open'
    WHEN 'WAITING_INTERNAL'   THEN 'Open'
    WHEN 'REOPENED'           THEN 'Open'
    WHEN 'RESOLVED'           THEN 'Done'
    WHEN 'CUSTOMER_CONFIRMED' THEN 'Done'
    WHEN 'CLOSED'             THEN 'Done'
    WHEN 'CANCELLED'          THEN 'Cancelled'
    ELSE 'Backlog'
  END
);

DROP INDEX IF EXISTS idx_tickets_lifecycle;
DROP INDEX IF EXISTS idx_tickets_plane_status;
DROP INDEX IF EXISTS idx_tickets_awaiting_customer;

ALTER TABLE tickets
  DROP COLUMN IF EXISTS plane_status,
  DROP COLUMN IF EXISTS lifecycle_changed_at;
