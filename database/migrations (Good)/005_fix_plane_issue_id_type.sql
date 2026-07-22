-- ============================================================
-- AutomationX V3 - Fix plane_issue_id column type mismatch
-- 005_fix_plane_issue_id_type.sql
-- ============================================================

ALTER TABLE tickets ALTER COLUMN plane_issue_id TYPE VARCHAR(255);
