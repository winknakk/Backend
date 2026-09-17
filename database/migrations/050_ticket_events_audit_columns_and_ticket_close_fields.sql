-- Migration 050: formalise columns the backend already writes (2026-09-17)
--
-- ticket_events.actor / correlation_id / source are written by
-- TicketStateMachine.recordEvent, CustomerConfirmationHandler.saveFeedback and
-- the case resolvers (event_type 'CLOSED_CASE_REFERENCED'); tickets.reopened_count
-- and tickets.closed_at are written by TicketStateMachine.transition. Until now
-- their DDL existed only in database/schema/03_support_operations.sql, which the
-- migration runner does not read, so a fresh database built from migrations
-- alone lacked them. Idempotent: a database that already has them is unchanged.

CREATE TABLE IF NOT EXISTS ticket_events (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  event_type VARCHAR(100) NOT NULL,
  actor VARCHAR(200),
  payload JSONB DEFAULT '{}'::jsonb,
  correlation_id VARCHAR(200),
  source VARCHAR(100),
  created_by VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ticket_events ADD COLUMN IF NOT EXISTS actor VARCHAR(200);
ALTER TABLE ticket_events ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(200);
ALTER TABLE ticket_events ADD COLUMN IF NOT EXISTS source VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_type_created
  ON ticket_events (ticket_id, event_type, created_at DESC);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopened_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
