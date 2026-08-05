-- Migration 027: Multi-Tenant Architecture & RLS Enforcers (V4 Foundation)

-- 1. Create Organizations Table
CREATE TABLE IF NOT EXISTS organizations (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(64) UNIQUE NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    api_key_hash VARCHAR(128) UNIQUE,
    webhook_secret VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed Default Organization
INSERT INTO organizations (id, name, slug)
VALUES ('org_default', 'Default Organization', 'default')
ON CONFLICT (id) DO NOTHING;

-- 2. Create customer_projects mapping table
CREATE TABLE IF NOT EXISTS customer_projects (
    org_id VARCHAR(64) NOT NULL DEFAULT 'org_default' REFERENCES organizations(id),
    customer_id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, customer_id, project_id)
);

-- 3. Add org_id to projects
ALTER TABLE projects ADD COLUMN IF NOT EXISTS org_id VARCHAR(64) NOT NULL DEFAULT 'org_default' REFERENCES organizations(id);
CREATE INDEX IF NOT EXISTS idx_projects_org_id ON projects(org_id);

-- 4. Add org_id to conversations
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS org_id VARCHAR(64) NOT NULL DEFAULT 'org_default' REFERENCES organizations(id);
CREATE INDEX IF NOT EXISTS idx_conversations_org_proj ON conversations(org_id, project_id);

-- 5. Add org_id to tickets
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS org_id VARCHAR(64) NOT NULL DEFAULT 'org_default' REFERENCES organizations(id);
CREATE INDEX IF NOT EXISTS idx_tickets_org_proj_conv ON tickets(org_id, project_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_tickets_org_plane_issue ON tickets(org_id, plane_issue_id);

-- 6. Add org_id to identities (if exists)
DO $$ 
BEGIN
    IF to_regclass('identities') IS NOT NULL THEN
        ALTER TABLE identities ADD COLUMN IF NOT EXISTS org_id VARCHAR(64) NOT NULL DEFAULT 'org_default' REFERENCES organizations(id);
        CREATE INDEX IF NOT EXISTS idx_identities_org_id ON identities(org_id);
    END IF;
    IF to_regclass('customers') IS NOT NULL THEN
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS org_id VARCHAR(64) NOT NULL DEFAULT 'org_default' REFERENCES organizations(id);
        CREATE INDEX IF NOT EXISTS idx_customers_org_id ON customers(org_id);
    END IF;
END $$;
