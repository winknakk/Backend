-- 1. Insert Demo Organizations
INSERT INTO organizations (id, name, slug)
VALUES 
    ('org_default', 'Default Organization', 'default'),
    ('org_avalant', 'Avalant Co.,Ltd.', 'avalant'),
    ('org_siam', 'Siam Banking Corp', 'siam'),
    ('org_acme', 'Acme Retail Group', 'acme'),
    ('org_demo', 'Demo Tenant', 'demo')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug;

-- Ensure Companies 6 and 7 exist
INSERT INTO companies (id, name)
VALUES (6, 'Siam Banking'), (7, 'Acme Retail')
ON CONFLICT (id) DO NOTHING;

-- Insert Demo Projects per Org
INSERT INTO projects (id, company_id, name, project_type, environment, org_id)
VALUES
    (15, 6, 'Siam Banking App', 'Mobile App', 'Production', 'org_siam'),
    (16, 7, 'Acme POS Portal', 'Web Portal', 'Production', 'org_acme')
ON CONFLICT (id) DO NOTHING;

-- 2. Create User Roles Table if not exists
CREATE TABLE IF NOT EXISTS user_roles (
    id VARCHAR(64) PRIMARY KEY,
    user_email VARCHAR(255) NOT NULL UNIQUE,
    role VARCHAR(32) NOT NULL,
    org_id VARCHAR(64) NOT NULL DEFAULT 'org_default' REFERENCES organizations(id),
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed User Roles
INSERT INTO user_roles (id, user_email, role, org_id)
VALUES
    ('role_superadmin', 'superadmin@ticketx.io', 'super_admin', 'org_default'),
    ('role_org_admin', 'admin@avalant.co.th', 'admin', 'org_avalant'),
    ('role_agent', 'agent@avalant.co.th', 'employee', 'org_avalant'),
    ('role_customer', 'customer@avalant.co.th', 'customer', 'org_avalant')
ON CONFLICT (user_email) DO UPDATE SET role = EXCLUDED.role, org_id = EXCLUDED.org_id;
