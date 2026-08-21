-- Migration 035: Plane Admin Observability & Mapping Uniqueness (P8)
-- Target System: TicketX / AutomationX Database

-- 1. Add observability and lifecycle columns
ALTER TABLE plane_workspace_mappings 
  ADD COLUMN IF NOT EXISTS connection_status VARCHAR(32) DEFAULT 'CONNECTED',
  ADD COLUMN IF NOT EXISTS last_tested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error_code VARCHAR(64),
  ADD COLUMN IF NOT EXISTS last_successful_sync_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- 2. Drop overly strict unique constraint on project_id alone if it exists to allow archived mappings
ALTER TABLE plane_workspace_mappings DROP CONSTRAINT IF EXISTS uq_plane_workspace_mappings_project;

-- 3. Enforce Uniqueness: 1 active enabled mapping per (project_id, org_id)
CREATE UNIQUE INDEX IF NOT EXISTS uq_plane_active_mapping_per_project 
ON plane_workspace_mappings (project_id, org_id) 
WHERE enabled = TRUE AND archived_at IS NULL;

-- 4. Index for active project lookup
CREATE INDEX IF NOT EXISTS idx_plane_active_lookup 
ON plane_workspace_mappings (project_id, org_id, enabled) 
WHERE archived_at IS NULL;
