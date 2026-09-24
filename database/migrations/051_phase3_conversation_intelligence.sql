-- ============================================================================
-- Migration 051: Phase 3 Customer & Conversation Intelligence
-- Target: AutomationX V3 / TicketX Platform
-- Schema: cs_tickets (or current search path)
-- Target Database: PostgreSQL 16+
-- ============================================================================

-- 1. DAILY PROJECT INTELLIGENCE (Deterministic daily operational rollups)
CREATE TABLE IF NOT EXISTS daily_project_intelligence (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  timezone VARCHAR(100) NOT NULL,
  total_conversations INTEGER NOT NULL DEFAULT 0,
  total_messages INTEGER NOT NULL DEFAULT 0,
  total_tickets INTEGER NOT NULL DEFAULT 0,
  resolved_tickets INTEGER NOT NULL DEFAULT 0,
  sla_breaches INTEGER NOT NULL DEFAULT 0,
  human_handoffs INTEGER NOT NULL DEFAULT 0,
  bot_deflection_rate NUMERIC(5,4) NOT NULL DEFAULT 0.0,
  avg_latency_ms NUMERIC(10,2) NOT NULL DEFAULT 0.0,
  total_tokens_consumed INTEGER NOT NULL DEFAULT 0,
  top_issue_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  top_knowledge_gaps JSONB NOT NULL DEFAULT '[]'::jsonb,
  narrative_summary TEXT,
  model_version VARCHAR(50) NOT NULL DEFAULT 'v1',
  algorithm_version VARCHAR(50) NOT NULL DEFAULT 'v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_intel_proj_date 
  ON daily_project_intelligence(project_id, date DESC);

-- 2. KNOWLEDGE GAP CANDIDATES (Multi-signal evidence and review lifecycle)
CREATE TABLE IF NOT EXISTS knowledge_gap_candidates (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  query_text TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  score NUMERIC(5,4) NOT NULL DEFAULT 0.0,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(50) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'resolved', 'ignored')),
  cluster_id VARCHAR(100),
  review_notes TEXT,
  reviewed_by VARCHAR(200),
  reviewed_at TIMESTAMPTZ,
  model_version VARCHAR(50) NOT NULL DEFAULT 'v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_kg_candidate_turn UNIQUE (project_id, conversation_id, message_id, model_version)
);

CREATE INDEX IF NOT EXISTS idx_kg_candidates_proj_status 
  ON knowledge_gap_candidates(project_id, status);

CREATE INDEX IF NOT EXISTS idx_kg_candidates_proj_created 
  ON knowledge_gap_candidates(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kg_candidates_cluster 
  ON knowledge_gap_candidates(project_id, cluster_id) 
  WHERE cluster_id IS NOT NULL;

-- 3. BOT FAILURE EVENTS (Taxonomy-classified incident log)
CREATE TABLE IF NOT EXISTS bot_failure_events (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  trace_id VARCHAR(255),
  failure_class VARCHAR(100) NOT NULL CHECK (failure_class IN (
    'knowledge_missing', 'retrieval_failed', 'tool_errored', 'routing_mismatch',
    'policy_blocked', 'evasive_response', 'late_escalation', 'context_omission'
  )),
  severity VARCHAR(50) NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  evidence_source VARCHAR(100) NOT NULL,
  evidence_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  taxonomy_version VARCHAR(50) NOT NULL DEFAULT 'v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_failures_proj_class 
  ON bot_failure_events(project_id, failure_class);

CREATE INDEX IF NOT EXISTS idx_bot_failures_proj_created 
  ON bot_failure_events(project_id, created_at DESC);

-- 4. BOT IMPROVEMENT PROPOSALS (Governed proposal and evaluation state machine)
CREATE TABLE IF NOT EXISTS bot_improvement_proposals (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  target_area VARCHAR(100) NOT NULL,
  proposed_changes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(50) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'evaluating', 'approved', 'deployed', 'rejected')),
  eval_results JSONB,
  eval_threshold_passed BOOLEAN NOT NULL DEFAULT FALSE,
  content_hash VARCHAR(64) NOT NULL,
  model_version VARCHAR(50) NOT NULL DEFAULT 'v1',
  created_by VARCHAR(200) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by VARCHAR(200),
  approved_at TIMESTAMPTZ,
  deployed_at TIMESTAMPTZ,
  rejected_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_proposals_proj_status 
  ON bot_improvement_proposals(project_id, status);

CREATE INDEX IF NOT EXISTS idx_bot_proposals_proj_created 
  ON bot_improvement_proposals(project_id, created_at DESC);
