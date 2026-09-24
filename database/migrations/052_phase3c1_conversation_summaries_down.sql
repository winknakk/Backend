-- Down migration for 052_phase3c1_conversation_summaries.sql

ALTER TABLE daily_project_intelligence DROP CONSTRAINT IF EXISTS chk_daily_intel_narrative_source;
ALTER TABLE daily_project_intelligence DROP COLUMN IF EXISTS narrative_source;

UPDATE daily_project_intelligence SET total_tokens_consumed = 0 WHERE total_tokens_consumed IS NULL;
ALTER TABLE daily_project_intelligence
  ALTER COLUMN total_tokens_consumed SET DEFAULT 0,
  ALTER COLUMN total_tokens_consumed SET NOT NULL;

DROP TABLE IF EXISTS conversation_summaries;
