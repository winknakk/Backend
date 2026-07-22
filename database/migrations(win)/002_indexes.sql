-- ============================================================
-- AutomationX V2 - Indexes Migration
-- 002_indexes.sql
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_identities_channel_ref ON identities(channel, channel_ref);
CREATE INDEX IF NOT EXISTS idx_conversations_identity ON conversations(identity_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tickets_conversation ON tickets(conversation_id);
CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);
CREATE INDEX IF NOT EXISTS idx_traces_trace_id ON traces(trace_id);
CREATE INDEX IF NOT EXISTS idx_traces_agent ON traces(agent_id);
