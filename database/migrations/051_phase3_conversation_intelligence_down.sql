-- ============================================================================
-- Rollback for Migration 051: Phase 3 Customer & Conversation Intelligence
-- Drops ONLY Phase 3-owned derived structures; never touches shared tables.
-- ============================================================================

DROP TABLE IF EXISTS bot_improvement_proposals CASCADE;
DROP TABLE IF EXISTS bot_failure_events CASCADE;
DROP TABLE IF EXISTS knowledge_gap_candidates CASCADE;
DROP TABLE IF EXISTS daily_project_intelligence CASCADE;
