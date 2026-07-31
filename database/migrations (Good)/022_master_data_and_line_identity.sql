-- Migration 022: Master Data & LINE Identity Mapping Schema

-- 1. Ensure projects table has plan_status and code
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'plan_status') THEN
    ALTER TABLE projects ADD COLUMN plan_status VARCHAR(32) DEFAULT 'ACTIVE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'code') THEN
    ALTER TABLE projects ADD COLUMN code VARCHAR(64);
  END IF;
END $$;

-- Update existing projects with default plan_status and code
UPDATE projects SET plan_status = 'ACTIVE' WHERE plan_status IS NULL;
UPDATE projects SET code = CONCAT('PRJ-', id) WHERE code IS NULL;

-- 2. Customers Table
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  project_id INT REFERENCES projects(id) ON DELETE SET NULL,
  company_name VARCHAR(255) NOT NULL,
  contact_name VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Customer Identities Table (LINE User ID Mapping)
CREATE TABLE IF NOT EXISTS customer_identities (
  id SERIAL PRIMARY KEY,
  line_user_id VARCHAR(255) NOT NULL,
  customer_id INT REFERENCES customers(id) ON DELETE CASCADE,
  project_id INT REFERENCES projects(id) ON DELETE CASCADE,
  is_verified BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_line_customer_project UNIQUE (line_user_id, project_id)
);

-- Indexes for fast lookup
CREATE INDEX IF NOT EXISTS idx_customer_identities_line_user_id ON customer_identities(line_user_id);
CREATE INDEX IF NOT EXISTS idx_customer_identities_customer_id ON customer_identities(customer_id);
CREATE INDEX IF NOT EXISTS idx_customers_project_id ON customers(project_id);

-- Seed Initial Demo Customers if table is empty
INSERT INTO customers (id, project_id, company_name, contact_name, email, phone)
VALUES
  (1, 1, 'Orbit Retail Co., Ltd.', 'Sombat K.', 'sombat@orbitretail.co.th', '0812345678'),
  (2, 1, 'TechCorp Logistics', 'Wichai T.', 'wichai@techcorp.co.th', '0823456789'),
  (3, 2, 'HealthCare Plus', 'Kanda P.', 'kanda@healthcareplus.com', '0834567890'),
  (4, 3, 'FinTech Solutions', 'Apirak S.', 'apirak@fintechsolutions.io', '0845678901'),
  (5, 4, 'EduLearn Academy', 'Narin B.', 'narin@edulearn.ac.th', '0856789012')
ON CONFLICT (id) DO NOTHING;

-- Seed Initial LINE Identity Mappings
INSERT INTO customer_identities (id, line_user_id, customer_id, project_id, is_verified)
VALUES
  (1, 'U367f5ba23c8167bc4b15a7a4e7c52b26', 1, 1, true),
  (2, 'U981abc72619283719283719283719283', 2, 1, true),
  (3, 'U1234567890abcdef1234567890abcdef', 3, 2, true)
ON CONFLICT (id) DO NOTHING;
