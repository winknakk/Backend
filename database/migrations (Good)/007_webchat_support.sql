-- ============================================================
-- AutomationX V3 - WebChat Support Schema Migration
-- 007_webchat_support.sql
-- ============================================================

-- 1. Create WebChat Sessions Table
CREATE TABLE IF NOT EXISTS webchat_sessions (
  id SERIAL PRIMARY KEY,
  identity_id INTEGER NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  session_token VARCHAR(512) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_active_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create Message Attachments Table
CREATE TABLE IF NOT EXISTS message_attachments (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_url VARCHAR(2048) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(100),
  file_size INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create/Ensure Index on identities for optimized channel constraints
CREATE INDEX IF NOT EXISTS idx_identities_channel_ref ON identities(channel, channel_ref);
