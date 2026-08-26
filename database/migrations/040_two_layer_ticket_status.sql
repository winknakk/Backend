-- ============================================================
-- Migration 040: Two-layer ticket status
-- ============================================================
--
-- tickets.status has held PLANE's vocabulary since migration 023
-- (Backlog / Todo / In Progress / Done / Cancelled). That made Plane sync
-- trivial but left the customer half of the journey unrepresentable:
-- CUSTOMER_CONFIRMED and WAITING_CUSTOMER have no Plane equivalent, so the
-- Golden Flow could not be expressed at all.
--
-- After this migration the two concerns are explicit and separate:
--
--   tickets.status        TicketX CUSTOMER lifecycle (authoritative for the
--                         customer journey, confirmation, reopening, SLA)
--   tickets.plane_status  Plane ENGINEERING state (authoritative for work
--                         progress and completion)
--
-- The mapping between them lives in src/domain/ticket/TicketLifecycle.ts and
-- is deliberately asymmetric: Plane "Done" produces TicketX RESOLVED, never
-- CLOSED. Only the customer moves a ticket past RESOLVED.
--
-- Migrations 023 and 024 are NOT modified. They remain in the applied chain
-- as history; this migration moves forward from where they left the data.
--
-- DEPLOY TOGETHER WITH THE APPLICATION CODE. The CHECK constraint added at
-- the end rejects the old vocabulary, and code that writes 'open' or
-- 'Backlog' will fail against it.

-- ------------------------------------------------------------------
-- 1. Plane's engineering state joins the existing Plane snapshot group
--    (plane_workspace_slug, plane_project_id, plane_issue_id,
--     plane_last_seen_updated_at). This is the missing member of a group the
--    schema already has, not a duplicate state field.
-- ------------------------------------------------------------------
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS plane_status VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS lifecycle_changed_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN tickets.plane_status IS
  'Plane engineering state (Backlog/Open/Done/Cancelled). Plane is authoritative for this.';
COMMENT ON COLUMN tickets.status IS
  'TicketX customer lifecycle. TicketX is authoritative for this. See TicketLifecycle.ts.';

-- ------------------------------------------------------------------
-- 2. Today's status column IS the Plane state, so it backfills directly.
-- ------------------------------------------------------------------
UPDATE tickets
SET plane_status = CASE LOWER(BTRIM(status))
      WHEN 'backlog'     THEN 'Backlog'
      WHEN 'todo'        THEN 'Backlog'
      WHEN 'to do'       THEN 'Backlog'
      WHEN 'unstarted'   THEN 'Backlog'
      WHEN 'open'        THEN 'Open'
      WHEN 'in progress' THEN 'Open'
      WHEN 'in_progress' THEN 'Open'
      WHEN 'started'     THEN 'Open'
      WHEN 'done'        THEN 'Done'
      WHEN 'complete'    THEN 'Done'
      WHEN 'completed'   THEN 'Done'
      WHEN 'closed'      THEN 'Done'
      WHEN 'resolved'    THEN 'Done'
      WHEN 'cancelled'   THEN 'Cancelled'
      WHEN 'canceled'    THEN 'Cancelled'
      ELSE 'Backlog'
    END
WHERE plane_status IS NULL;

-- ------------------------------------------------------------------
-- 3. Rewrite status into the TicketX customer lifecycle.
--
--    HISTORICAL BACKFILL DECISION (approved 2026-08-26):
--    Existing Done / closed / resolved tickets map to CLOSED, NOT RESOLVED.
--
--    RESOLVED means "engineering is finished, waiting for the customer to
--    confirm", and reaching it triggers a resolution notification. Backfilling
--    historical tickets to RESOLVED would send resolution notifications to
--    customers about tickets that were finished weeks ago. Those tickets are
--    finished business; they go straight to CLOSED.
--
--    Verified before applying: 1 ticket is affected, so exactly 1 spurious
--    notification is avoided today. The rule matters more as the table grows.
-- ------------------------------------------------------------------
UPDATE tickets
SET status = CASE LOWER(BTRIM(status))
      WHEN 'backlog'     THEN 'NEW'
      WHEN 'todo'        THEN 'TRIAGED'
      WHEN 'to do'       THEN 'TRIAGED'
      WHEN 'unstarted'   THEN 'TRIAGED'
      WHEN 'open'        THEN 'OPEN'
      WHEN 'in progress' THEN 'IN_PROGRESS'
      WHEN 'in_progress' THEN 'IN_PROGRESS'
      WHEN 'started'     THEN 'IN_PROGRESS'
      WHEN 'done'        THEN 'CLOSED'
      WHEN 'complete'    THEN 'CLOSED'
      WHEN 'completed'   THEN 'CLOSED'
      WHEN 'closed'      THEN 'CLOSED'
      WHEN 'resolved'    THEN 'CLOSED'
      WHEN 'cancelled'   THEN 'CANCELLED'
      WHEN 'canceled'    THEN 'CANCELLED'
      -- Anything unrecognised is treated as untriaged rather than guessed at.
      ELSE 'NEW'
    END,
    lifecycle_changed_at = COALESCE(lifecycle_changed_at, updated_at, created_at, NOW());

-- ------------------------------------------------------------------
-- 4. Close the vocabulary.
--
--    status was free text, which is how 'Open' survived migration 023 while
--    every other alias was normalised. A closed vocabulary is what makes the
--    state machine meaningful: an unguarded UPDATE now fails loudly instead
--    of silently inventing a status.
-- ------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'tickets'::regclass AND conname = 'tickets_status_lifecycle_check'
  ) THEN
    ALTER TABLE tickets
      ADD CONSTRAINT tickets_status_lifecycle_check
      CHECK (status IN (
        'NEW','TRIAGED','OPEN','IN_PROGRESS','WAITING_CUSTOMER','WAITING_INTERNAL',
        'RESOLVED','CUSTOMER_CONFIRMED','CLOSED','REOPENED','CANCELLED'
      ));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'tickets'::regclass AND conname = 'tickets_plane_status_check'
  ) THEN
    ALTER TABLE tickets
      ADD CONSTRAINT tickets_plane_status_check
      CHECK (plane_status IS NULL OR plane_status IN ('Backlog','Open','Done','Cancelled'));
  END IF;
END
$$;

-- ------------------------------------------------------------------
-- 5. Indexes for the queries the lifecycle introduces.
-- ------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_tickets_lifecycle ON tickets (status, project_id);

CREATE INDEX IF NOT EXISTS idx_tickets_plane_status ON tickets (plane_status)
  WHERE plane_status IS NOT NULL;

-- Tickets awaiting customer confirmation - the queue the confirmation flow
-- and any follow-up reminder read.
CREATE INDEX IF NOT EXISTS idx_tickets_awaiting_customer
  ON tickets (lifecycle_changed_at)
  WHERE status = 'RESOLVED';
