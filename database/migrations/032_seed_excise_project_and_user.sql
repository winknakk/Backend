-- ====================================================================
-- Migration 032: Seed Excise Department (EXC03) Project & Mock User
-- Target System: TicketX / AutomationX Database
-- ====================================================================

-- 1. Insert Excise Organization
INSERT INTO organizations (id, name, slug)
VALUES ('org_excise', 'กรมสรรพสามิต (Excise Department)', 'excise')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug;

-- 2. Insert Excise Company
INSERT INTO companies (id, name)
VALUES (101, 'กรมสรรพสามิต')
ON CONFLICT (id) DO NOTHING;

-- 3. Insert Excise Project (EXC03)
INSERT INTO projects (id, company_id, name, project_type, environment, org_id)
VALUES (101, 101, 'EXC03 - ระบบสารสนเทศกรมสรรพสามิต', 'Enterprise Web Application (OneWeb EE)', 'Production', 'org_excise')
ON CONFLICT (id) DO NOTHING;

-- 4. Insert Mock User & Role for Excise Project
INSERT INTO user_roles (id, user_email, role, org_id, status)
VALUES (
    'usr_excise_001',
    'somchai.excise@excise.go.th',
    'customer',
    'org_excise',
    'active'
)
ON CONFLICT (user_email) DO UPDATE SET role = EXCLUDED.role, org_id = EXCLUDED.org_id;

-- 5. Insert Git Repository Mapping for Live Project Knowledge Engine (P0-P1)
INSERT INTO project_git_repositories (
    id,
    project_id,
    provider,
    repo_url,
    default_branch,
    auth_type,
    status,
    org_id
)
VALUES (
    'repo_excise_001',
    101,
    'gitlab',
    'http://192.168.0.136/HCMProductV4/exc03_excise.git',
    'master',
    'none',
    'active',
    'org_excise'
)
ON CONFLICT (id) DO NOTHING;

-- 6. Insert Customers Master Data
INSERT INTO customers (id, project_id, company_name, contact_name, email, phone)
VALUES
    (1, 1, 'AutomationX Demo Company', 'User LINE Main', 'user.line@automationx.io', '0812345678'),
    (101, 101, 'กรมสรรพสามิต (Excise Department)', 'สมชาย สรรพสามิต', 'somchai.excise@excise.go.th', '0899999999')
ON CONFLICT (id) DO UPDATE SET company_name = EXCLUDED.company_name, contact_name = EXCLUDED.contact_name;

-- 7. Link LINE User U367f5ba23c8167bc4b15a7a4e7c52b26 to 2 Projects Simultaneously
-- Project 1 (AutomationX Demo) AND Project 101 (EXC03 - กรมสรรพสามิต)
INSERT INTO customer_identities (line_user_id, customer_id, project_id, is_verified)
VALUES
    ('U367f5ba23c8167bc4b15a7a4e7c52b26', 1, 1, true),
    ('U367f5ba23c8167bc4b15a7a4e7c52b26', 101, 101, true)
ON CONFLICT (line_user_id, project_id) DO UPDATE SET customer_id = EXCLUDED.customer_id, is_verified = true;

