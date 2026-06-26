-- ============================================================
-- AutomationX V2 - Initial Schema Migration
-- 001_initial_schema.sql
-- ============================================================

-- Create replication role if it does not exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'replicator') THEN
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator_password';
  END IF;
END
$$;

-- Companies
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Profiles
CREATE TABLE IF NOT EXISTS profiles (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  name VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  name VARCHAR(255) NOT NULL,
  project_type VARCHAR(100) DEFAULT 'Support',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Identities (channel-specific user references)
CREATE TABLE IF NOT EXISTS identities (
  id SERIAL PRIMARY KEY,
  profile_id INTEGER REFERENCES profiles(id),
  channel VARCHAR(50) NOT NULL,
  channel_ref VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  identity_id INTEGER REFERENCES identities(id),
  project_id INTEGER REFERENCES projects(id),
  channel VARCHAR(50) NOT NULL,
  status VARCHAR(50) DEFAULT 'open',
  handled_by VARCHAR(50) DEFAULT 'ai',
  assigned_pm VARCHAR(255),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id),
  role VARCHAR(50) NOT NULL,
  content TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tickets
CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  ticket_id VARCHAR(100) UNIQUE NOT NULL,
  conversation_id INTEGER REFERENCES conversations(id),
  subject VARCHAR(500),
  summary TEXT,
  status VARCHAR(50) DEFAULT 'open',
  priority VARCHAR(50),
  severity VARCHAR(50),
  assigned_pm VARCHAR(255),
  created_via VARCHAR(50) DEFAULT 'ai',
  plane_issue_id VARCHAR(255),
  due_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Traces (execution audit logs)
CREATE TABLE IF NOT EXISTS traces (
  id SERIAL PRIMARY KEY,
  trace_id UUID UNIQUE NOT NULL,
  session_id VARCHAR(255) NOT NULL,
  agent_id VARCHAR(255),
  tool_name VARCHAR(255) NOT NULL,
  called_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  arguments JSONB DEFAULT '{}',
  result JSONB,
  status VARCHAR(50) DEFAULT 'RUNNING',
  error_message TEXT,
  completed_at TIMESTAMPTZ,
  request_id VARCHAR(255),
  conversation_id VARCHAR(255),
  parent_trace_id VARCHAR(255)
);

