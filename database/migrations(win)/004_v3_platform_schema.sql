-- ============================================================
-- AutomationX V3 - Platform Configuration Schema Migration
-- 004_v3_platform_schema.sql
-- ============================================================

-- 1. Create Project Configurations Tables
CREATE TABLE IF NOT EXISTS project_prompts (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  system_instruction TEXT NOT NULL,
  model_name VARCHAR(100) DEFAULT 'gemini-1.5-pro',
  temperature NUMERIC(3,2) DEFAULT 0.00,
  max_tokens INTEGER DEFAULT 2048,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_sla_policies (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  priority VARCHAR(50) NOT NULL,
  resolve_hours INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, priority)
);

CREATE TABLE IF NOT EXISTS project_channels (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_type VARCHAR(50) NOT NULL,
  channel_id VARCHAR(255) NOT NULL,
  secret_token TEXT,
  credentials_json JSONB DEFAULT '{}',
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_ai_settings (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE UNIQUE,
  confidence_threshold NUMERIC(3,2) DEFAULT 0.70,
  max_handoff_depth INTEGER DEFAULT 5,
  vector_match_threshold NUMERIC(3,2) DEFAULT 0.60,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_routing_rules (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rule_type VARCHAR(100) NOT NULL,
  conditions JSONB DEFAULT '{}',
  target_handler VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_business_hours (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  timezone VARCHAR(100) DEFAULT 'UTC',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_holidays (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  holiday_date DATE NOT NULL,
  name VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, holiday_date)
);

CREATE TABLE IF NOT EXISTS project_mcp_permissions (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tool_name VARCHAR(255) NOT NULL,
  allowed_roles VARCHAR(100)[] DEFAULT '{}',
  policy_rules JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, tool_name)
);

CREATE TABLE IF NOT EXISTS project_feature_flags (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  flag_name VARCHAR(255) NOT NULL,
  is_enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, flag_name)
);

-- 2. Add Nullable project_id to tickets table
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id);

-- 3. Create Optimization Indices
CREATE INDEX IF NOT EXISTS idx_conversations_project_id ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_tickets_project_id ON tickets(project_id);
CREATE INDEX IF NOT EXISTS idx_project_prompts_project_id ON project_prompts(project_id);
CREATE INDEX IF NOT EXISTS idx_project_sla_policies_project_id ON project_sla_policies(project_id);
CREATE INDEX IF NOT EXISTS idx_project_channels_project_id ON project_channels(project_id);

-- 4. Seed Default Configurations for Default Project 1
-- Ensure project 1 exists first
INSERT INTO companies (id, name) VALUES (1, 'Default Company') ON CONFLICT DO NOTHING;
INSERT INTO projects (id, company_id, name) VALUES (1, 1, 'Default Project') ON CONFLICT DO NOTHING;

-- Seed prompts config
INSERT INTO project_prompts (project_id, system_instruction, model_name, temperature, max_tokens)
VALUES (1, 'You are an helpful AI Assistant designed to resolve tickets and support customers.', 'gemini-1.5-pro', 0.00, 2048);

-- Seed SLA policies
INSERT INTO project_sla_policies (project_id, priority, resolve_hours) VALUES
  (1, 'P1', 4),
  (1, 'P2', 24),
  (1, 'P3', 72),
  (1, 'P4', 168)
ON CONFLICT (project_id, priority) DO NOTHING;

-- Seed AI settings
INSERT INTO project_ai_settings (project_id, confidence_threshold, max_handoff_depth, vector_match_threshold)
VALUES (1, 0.70, 5, 0.60)
ON CONFLICT (project_id) DO NOTHING;

-- Seed Feature Flags
INSERT INTO project_feature_flags (project_id, flag_name, is_enabled) VALUES
  (1, 'enable_auto_escalation', true),
  (1, 'enable_rag_search', true)
ON CONFLICT (project_id, flag_name) DO NOTHING;
