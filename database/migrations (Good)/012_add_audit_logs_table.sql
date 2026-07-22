-- Migration: Add admin_audit_logs table for settings auditability
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  old_value JSONB DEFAULT '{}',
  new_value JSONB DEFAULT '{}',
  actor VARCHAR(255) DEFAULT 'admin',
  timestamp TIMESTAMPTZ DEFAULT NOW()
);
