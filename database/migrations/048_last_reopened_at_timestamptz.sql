-- 048: tickets.last_reopened_at was declared VARCHAR (like first_response_at
-- before migration 045). The re-open path (2026-09-08) compares it with
-- timestamps (SLA cadence anchor, feedback-capture window), so it becomes a
-- real TIMESTAMPTZ. Existing text values are parsed; unparseable ones are
-- dropped rather than failing the migration.
ALTER TABLE tickets
  ALTER COLUMN last_reopened_at TYPE TIMESTAMPTZ
  USING (
    CASE
      WHEN last_reopened_at IS NULL OR last_reopened_at = '' THEN NULL
      WHEN last_reopened_at ~ '^\d{4}-\d{2}-\d{2}' THEN last_reopened_at::timestamptz
      ELSE NULL
    END
  );

INSERT INTO schema_migrations (version)
VALUES ('048_last_reopened_at_timestamptz.sql')
ON CONFLICT DO NOTHING;
