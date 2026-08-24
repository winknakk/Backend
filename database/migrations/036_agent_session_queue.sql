-- Migration 036: Per-Conversation Agent Message Queue & Atomic Session Lease
-- Purpose: Serialize Agent turns per conversation to prevent duplicate/interleaved messages breaking LLM tool continuation (HTTP 400 Bad Request)

-- 1. Create table for durable per-conversation message queue
CREATE TABLE IF NOT EXISTS agent_session_queue (
    id BIGSERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    source_event_id VARCHAR(255),
    channel VARCHAR(50) NOT NULL DEFAULT 'line',
    sender_ref VARCHAR(255) NOT NULL,
    destination VARCHAR(255),
    project_id INTEGER,
    payload JSONB NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'queued', -- 'queued', 'processing', 'completed', 'failed', 'dead_letter'
    lease_token VARCHAR(100),
    lease_expires_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    error_detail TEXT,
    sequence_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- Idempotency constraint per conversation + source event ID (deduplicates replayed/duplicated webhooks)
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_session_queue_conv_event 
    ON agent_session_queue(conversation_id, source_event_id) 
    WHERE source_event_id IS NOT NULL;

-- Fast index for queue processing order per conversation
CREATE INDEX IF NOT EXISTS idx_agent_session_queue_conv_status 
    ON agent_session_queue(conversation_id, status, sequence_at);

-- Fast index for lease expiration recovery
CREATE INDEX IF NOT EXISTS idx_agent_session_queue_leases 
    ON agent_session_queue(status, lease_expires_at);

-- 2. Create table for active conversation lease state
CREATE TABLE IF NOT EXISTS agent_session_state (
    conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    active_queue_item_id BIGINT REFERENCES agent_session_queue(id) ON DELETE SET NULL,
    lease_token VARCHAR(100),
    lease_expires_at TIMESTAMPTZ,
    last_active_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
