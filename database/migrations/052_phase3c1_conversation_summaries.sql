-- ============================================================================
-- Migration 052: Phase 3C.1 — Conversation summaries + honest daily telemetry
-- Target: AutomationX V3 / TicketX Platform
-- Schema: cs_tickets (or current search path)
-- ============================================================================
--
-- 1. conversation_summaries
--    One AI-generated semantic summary per (project, conversation, prompt
--    version). Holds only the validated model output and its provenance.
--    Authoritative facts (ticket status, handoff, assignee, counts) are NOT
--    stored here; they are read live from their own tables.
--    Staleness: source_last_message_id / source_message_count are the message
--    watermark at generation time. A summary whose watermark differs from the
--    conversation's current messages is stale.
--
-- 2. daily_project_intelligence.total_tokens_consumed
--    Migration 051 made it NOT NULL DEFAULT 0, but no AI path reports token
--    usage (PromptX does not return it), so every stored 0 was a fabricated
--    measurement. NULL now means "not measured".
--
-- 3. daily_project_intelligence.narrative_source
--    'template' = deterministic text built from the SQL facts;
--    'ai_validated' = generated narrative whose every number was checked
--    against the facts. The facts columns remain authoritative either way.

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  prompt_version VARCHAR(50) NOT NULL,
  summary JSONB NULL,
  generation_status VARCHAR(20) NOT NULL DEFAULT 'generating'
    CHECK (generation_status IN ('generating', 'ready', 'failed')),
  source_last_message_id INTEGER NULL REFERENCES messages(id) ON DELETE SET NULL,
  source_message_count INTEGER NOT NULL DEFAULT 0,
  provider VARCHAR(50) NULL,
  model VARCHAR(100) NULL,
  model_version VARCHAR(100) NULL,
  generated_at TIMESTAMPTZ NULL,
  generation_started_at TIMESTAMPTZ NULL,
  last_error_category VARCHAR(50) NULL,
  last_attempt_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_conversation_summary UNIQUE (project_id, conversation_id, prompt_version)
);

CREATE INDEX IF NOT EXISTS idx_conversation_summaries_conversation
  ON conversation_summaries(conversation_id);

ALTER TABLE daily_project_intelligence
  ALTER COLUMN total_tokens_consumed DROP NOT NULL,
  ALTER COLUMN total_tokens_consumed DROP DEFAULT;

-- Every existing value was the hard-coded 0, never a measurement.
UPDATE daily_project_intelligence SET total_tokens_consumed = NULL;

ALTER TABLE daily_project_intelligence
  ADD COLUMN IF NOT EXISTS narrative_source VARCHAR(20) NOT NULL DEFAULT 'template';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_daily_intel_narrative_source'
  ) THEN
    ALTER TABLE daily_project_intelligence
      ADD CONSTRAINT chk_daily_intel_narrative_source
      CHECK (narrative_source IN ('template', 'ai_validated'));
  END IF;
END $$;
