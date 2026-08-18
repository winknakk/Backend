-- Migration 034: Multi-Plane Project Routing Mappings & Ticket Historical Snapshots (P7)
-- Target System: TicketX / AutomationX Database

-- 1. Ensure projects table has org_id if not present
ALTER TABLE projects ADD COLUMN IF NOT EXISTS org_id VARCHAR(64) DEFAULT 'org_default';

-- 2. Create or extend plane_workspace_mappings table
CREATE TABLE IF NOT EXISTS plane_workspace_mappings (
    id SERIAL PRIMARY KEY,
    org_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    workspace_slug VARCHAR(128) NOT NULL DEFAULT 'cs-team',
    plane_project_id VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safely add missing P7 columns to plane_workspace_mappings if table pre-existed
ALTER TABLE plane_workspace_mappings ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE plane_workspace_mappings ADD COLUMN IF NOT EXISTS plane_api_base_url VARCHAR(255) NOT NULL DEFAULT 'https://projects.oneweb.tech';
ALTER TABLE plane_workspace_mappings ADD COLUMN IF NOT EXISTS credential_ref VARCHAR(255) NOT NULL DEFAULT 'plane_api_08c97a9323bf4854b6bae958d7577f60';
ALTER TABLE plane_workspace_mappings ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Drop legacy UNIQUE constraint on org_id from Migration 028 (since one org can have multiple projects)
ALTER TABLE plane_workspace_mappings DROP CONSTRAINT IF EXISTS plane_workspace_mappings_org_id_key;

-- Add UNIQUE(project_id) constraint safely
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_plane_workspace_mappings_project') THEN
        ALTER TABLE plane_workspace_mappings ADD CONSTRAINT uq_plane_workspace_mappings_project UNIQUE (project_id);
    END IF;
END $$;

-- Index for resolver query: WHERE project_id = $1 AND org_id = $2 AND enabled = TRUE
CREATE INDEX IF NOT EXISTS idx_plane_workspace_mappings_resolver ON plane_workspace_mappings(project_id, org_id, enabled);

-- 3. Add historical snapshot columns to tickets table
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS plane_workspace_slug VARCHAR(128);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS plane_project_id VARCHAR(128);

-- 3-key scope index for reverse sync and webhooks
CREATE INDEX IF NOT EXISTS idx_tickets_plane_3key ON tickets(plane_workspace_slug, plane_project_id, plane_issue_id);

-- 4. Seed Project 1 (SCG / Default Project) mapping
INSERT INTO plane_workspace_mappings (project_id, org_id, workspace_slug, plane_project_id, plane_api_base_url, credential_ref, enabled)
VALUES (1, 'org_default', 'cs-team', '09aa9c0e-8448-426f-8128-306c3dcf9d78', 'https://projects.oneweb.tech', 'plane_api_08c97a9323bf4854b6bae958d7577f60', TRUE)
ON CONFLICT (project_id) DO UPDATE SET
    org_id = EXCLUDED.org_id,
    workspace_slug = EXCLUDED.workspace_slug,
    plane_project_id = EXCLUDED.plane_project_id,
    plane_api_base_url = EXCLUDED.plane_api_base_url,
    credential_ref = EXCLUDED.credential_ref,
    enabled = EXCLUDED.enabled,
    updated_at = NOW();

-- 5. Seed Project 101 (Excise Project) mapping
INSERT INTO plane_workspace_mappings (project_id, org_id, workspace_slug, plane_project_id, plane_api_base_url, credential_ref, enabled)
VALUES (101, 'org_excise', 'cs-team', 'e3454524-961a-4b84-8ccb-71575baaa696', 'https://projects.oneweb.tech', 'plane_api_08c97a9323bf4854b6bae958d7577f60', TRUE)
ON CONFLICT (project_id) DO UPDATE SET
    org_id = EXCLUDED.org_id,
    workspace_slug = EXCLUDED.workspace_slug,
    plane_project_id = EXCLUDED.plane_project_id,
    plane_api_base_url = EXCLUDED.plane_api_base_url,
    credential_ref = EXCLUDED.credential_ref,
    enabled = EXCLUDED.enabled,
    updated_at = NOW();
