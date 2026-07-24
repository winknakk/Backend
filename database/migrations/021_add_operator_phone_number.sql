-- ============================================================
-- Migration 021: Add operator phone_number and seed SMS Admins
-- ============================================================

-- 1. Add phone_number column to operators table
ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS phone_number VARCHAR(50);

-- 2. Seed / Update Admin Good (Project Admin for Project ID 1)
INSERT INTO operators (company_id, email, name, display_name, role, status, phone_number)
VALUES (1, 'admin.good@ticketx.local', 'Admin Good', 'Admin Good', 'admin', 'active', '0942415642')
ON CONFLICT (company_id, email)
DO UPDATE SET
  name = EXCLUDED.name,
  display_name = EXCLUDED.display_name,
  phone_number = EXCLUDED.phone_number,
  role = 'admin',
  status = 'active';

-- Assign Admin Good to Project ID 1
INSERT INTO operator_project_access (operator_id, project_id, role)
SELECT id, 1, 'manager'
FROM operators
WHERE email = 'admin.good@ticketx.local'
ON CONFLICT (operator_id, project_id) DO NOTHING;

-- 3. Seed / Update Admin Win (Global Fallback Super Admin in DB)
INSERT INTO operators (company_id, email, name, display_name, role, status, phone_number)
VALUES (1, 'admin.win@ticketx.local', 'Admin Win', 'Admin Win', 'super_admin', 'active', '0633628242')
ON CONFLICT (company_id, email)
DO UPDATE SET
  name = EXCLUDED.name,
  display_name = EXCLUDED.display_name,
  phone_number = EXCLUDED.phone_number,
  role = 'super_admin',
  status = 'active';
