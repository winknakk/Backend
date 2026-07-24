-- ============================================================================
-- AutomationX V3 Platform — Production Permissions & Roles
-- Target Database: PostgreSQL 16+
-- ============================================================================

-- Create Application Database User Role
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'automationx_app') THEN
        CREATE ROLE automationx_app WITH LOGIN PASSWORD 'CHANGE_IN_PRODUCTION_SECURE_PASSWORD';
    END IF;
END
$$;

-- Grant Schema Permissions
GRANT CONNECT ON DATABASE postgres TO automationx_app;
GRANT USAGE ON SCHEMA public TO automationx_app;

-- Grant Table & Sequence Privileges
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO automationx_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO automationx_app;

-- Alter Default Privileges for Future Tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO automationx_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO automationx_app;
