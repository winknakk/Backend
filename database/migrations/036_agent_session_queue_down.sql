-- Rollback Migration 036: Per-Conversation Agent Message Queue & Atomic Session Lease

DROP TABLE IF EXISTS agent_session_state;
DROP TABLE IF EXISTS agent_session_queue;
