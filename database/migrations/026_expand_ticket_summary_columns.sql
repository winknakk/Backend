-- ============================================================================
-- Migration 026: Expand Ticket summary columns for real conversation context
-- ============================================================================
-- PostgreSQL V3 runtime databases may still have these columns as VARCHAR(50),
-- even though the canonical Ticket schema defines both as TEXT. Running
-- summaries are intentionally cumulative and must not be truncated.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'tickets'
      AND column_name = 'running_summary'
      AND data_type <> 'text'
  ) THEN
    ALTER TABLE tickets
      ALTER COLUMN running_summary TYPE text
      USING running_summary::text;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'tickets'
      AND column_name = 'last_ai_summary'
      AND data_type <> 'text'
  ) THEN
    ALTER TABLE tickets
      ALTER COLUMN last_ai_summary TYPE text
      USING last_ai_summary::text;
  END IF;
END;
$$;
