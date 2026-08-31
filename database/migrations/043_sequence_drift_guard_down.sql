-- ============================================================
-- 043_sequence_drift_guard_down.sql
-- Intentional no-op.
--
-- The up migration only moves SERIAL sequence counters forward to match the
-- data already in each table. Rewinding them would hand out ids that already
-- exist and reproduce the duplicate-key outage this migration was written to
-- fix, so there is nothing safe to undo here.
--
-- To roll back the accompanying code change, revert the commit; the previous
-- MAX(id)+1 writers still work against a realigned sequence.
-- ============================================================

SELECT 1;
