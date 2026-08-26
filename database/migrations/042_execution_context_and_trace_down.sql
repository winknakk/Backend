-- Rollback for migration 042.
DROP INDEX IF EXISTS idx_tickets_correlation;
ALTER TABLE tickets
  DROP COLUMN IF EXISTS execution_context_id,
  DROP COLUMN IF EXISTS correlation_id;

DROP INDEX IF EXISTS idx_trace_events_correlation;
DROP INDEX IF EXISTS idx_trace_events_parent;
DROP INDEX IF EXISTS idx_trace_events_ticket;
DROP INDEX IF EXISTS idx_trace_events_line_event;
DROP TABLE IF EXISTS trace_events;

DROP INDEX IF EXISTS uq_execution_contexts_context_id;
DROP INDEX IF EXISTS idx_execution_contexts_conversation;
DROP INDEX IF EXISTS idx_execution_contexts_correlation;
DROP INDEX IF EXISTS idx_execution_contexts_expiry;
DROP TABLE IF EXISTS execution_contexts;
