-- Migration 028: Plane Workspace Mappings & Line Destination Mapping

CREATE TABLE IF NOT EXISTS plane_workspace_mappings (
    id SERIAL PRIMARY KEY,
    org_id VARCHAR(64) NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    workspace_slug VARCHAR(128) NOT NULL DEFAULT 'ask-natapohn',
    plane_project_id VARCHAR(128) NOT NULL DEFAULT '4e840554-dc75-4e39-b87d-db31d8bcc1c9',
    plane_api_key VARCHAR(255) NOT NULL DEFAULT 'plane_api_6d16b662f16343e090c345cc76f59b03',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default mapping for org_default
INSERT INTO plane_workspace_mappings (org_id, workspace_slug, plane_project_id, plane_api_key)
VALUES ('org_default', 'ask-natapohn', '4e840554-dc75-4e39-b87d-db31d8bcc1c9', 'plane_api_6d16b662f16343e090c345cc76f59b03')
ON CONFLICT (org_id) DO NOTHING;

-- Seed mapping for org_avalant if exists in organizations table
INSERT INTO plane_workspace_mappings (org_id, workspace_slug, plane_project_id, plane_api_key)
SELECT id, 'ask-natapohn', '4e840554-dc75-4e39-b87d-db31d8bcc1c9', 'plane_api_6d16b662f16343e090c345cc76f59b03'
FROM organizations WHERE id = 'org_avalant'
ON CONFLICT (org_id) DO NOTHING;

-- Add line_destination_id column to projects table if not exists
ALTER TABLE projects ADD COLUMN IF NOT EXISTS line_destination_id VARCHAR(128);
