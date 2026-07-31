-- ============================================================
-- Migration 023: Store Plane work-item state names in tickets.status
-- ============================================================

-- Existing TicketX aliases become the matching Plane states.  A historical
-- `closed` record has no retained Plane state-group, so it is safely treated
-- as Done; an already-cancelled record remains Cancelled.
UPDATE tickets
SET status = CASE LOWER(BTRIM(status))
  WHEN 'open' THEN 'Backlog'
  WHEN 'backlog' THEN 'Backlog'
  WHEN 'todo' THEN 'Todo'
  WHEN 'to do' THEN 'Todo'
  WHEN 'unstarted' THEN 'Todo'
  WHEN 'in progress' THEN 'In Progress'
  WHEN 'in_progress' THEN 'In Progress'
  WHEN 'started' THEN 'In Progress'
  WHEN 'closed' THEN 'Done'
  WHEN 'done' THEN 'Done'
  WHEN 'complete' THEN 'Done'
  WHEN 'completed' THEN 'Done'
  WHEN 'resolved' THEN 'Done'
  WHEN 'cancelled' THEN 'Cancelled'
  WHEN 'canceled' THEN 'Cancelled'
  ELSE status
END,
updated_at = NOW()
WHERE LOWER(BTRIM(status)) IN (
  'open', 'backlog', 'todo', 'to do', 'unstarted', 'in progress',
  'in_progress', 'started', 'closed', 'done', 'complete', 'completed',
  'resolved', 'cancelled', 'canceled'
);
