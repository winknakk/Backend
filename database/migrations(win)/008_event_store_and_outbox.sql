-- ============================================================
-- AutomationX V3 - Event Store and Transactional Outbox Schema
-- 008_event_store_and_outbox.sql
-- ============================================================

-- 1. Create Conversation Events Table for Event Store
CREATE TABLE IF NOT EXISTS conversation_events (
  id SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  event_type VARCHAR(255) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  correlation_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create Transactional Outbox Events Table
CREATE TABLE IF NOT EXISTS outbox_events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(255) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create Optimization Indices
CREATE INDEX IF NOT EXISTS idx_conversation_events_conversation_id ON conversation_events(conversation_id);
CREATE INDEX IF NOT EXISTS idx_outbox_events_status ON outbox_events(status);
