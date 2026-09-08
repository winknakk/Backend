-- Down for 048: back to the legacy VARCHAR representation.
ALTER TABLE tickets
  ALTER COLUMN last_reopened_at TYPE VARCHAR(255)
  USING (CASE WHEN last_reopened_at IS NULL THEN NULL ELSE last_reopened_at::text END);

DELETE FROM schema_migrations WHERE version = '048_last_reopened_at_timestamptz.sql';
