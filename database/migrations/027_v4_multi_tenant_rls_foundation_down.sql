-- Rollback Script for Migration 027 (Multi-Tenant Architecture V4)
-- Objective: Safely drop RLS policies, indexes, and revert org_id additions without dropping legacy data.

DROP POLICY IF EXISTS tenant_isolation_tickets ON tickets;
DROP POLICY IF EXISTS tenant_isolation_conversations ON conversations;
ALTER TABLE tickets DISABLE ROW LEVEL SECURITY;
ALTER TABLE conversations DISABLE ROW LEVEL SECURITY;

DROP INDEX IF EXISTS idx_tickets_org_plane_issue;
DROP INDEX IF EXISTS idx_tickets_org_proj_conv;
DROP INDEX IF EXISTS idx_conversations_org_proj;
DROP INDEX IF EXISTS idx_customers_org_id;
DROP INDEX IF EXISTS idx_projects_org_id;

ALTER TABLE tickets DROP COLUMN IF EXISTS org_id;
ALTER TABLE conversations DROP COLUMN IF EXISTS org_id;
ALTER TABLE customer_identities DROP COLUMN IF EXISTS org_id;
ALTER TABLE customers DROP COLUMN IF EXISTS org_id;
ALTER TABLE projects DROP COLUMN IF EXISTS org_id;

DROP TABLE IF EXISTS customer_projects;
DROP TABLE IF EXISTS organizations;
