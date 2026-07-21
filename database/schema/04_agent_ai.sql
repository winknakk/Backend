-- ============================================================
-- TicketX / PromptX Platform — Agent AI Context Schema
-- /database/schema/04_agent_ai.sql
-- Target Database: PostgreSQL 16+
-- ============================================================

-- 1. TRACES (Tool Execution Logs)
CREATE TABLE IF NOT EXISTS traces (
  id              SERIAL PRIMARY KEY,
  trace_id        VARCHAR(255) UNIQUE,
  conversation_id VARCHAR(255),
  project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  parent_trace_id VARCHAR(255),
  tool_name       VARCHAR(255) NOT NULL,
  arguments       JSONB NOT NULL DEFAULT '{}',
  result          JSONB NOT NULL DEFAULT '{}',
  status          VARCHAR(50) NOT NULL DEFAULT 'success',
  execution_time  NUMERIC(10,3),
  called_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_usd        NUMERIC(10,6),
  latency_ms      INTEGER,
  model_name      VARCHAR(100),
  guardrail_result VARCHAR(20)
);

COMMENT ON TABLE traces IS 'Tool execution traces logged by AgentRuntime';

CREATE INDEX idx_traces_called_at ON traces(called_at DESC);
CREATE INDEX idx_traces_project_time ON traces(project_id, called_at DESC) WHERE project_id IS NOT NULL;

-- 2. AI THINKING TRACES (Chain of Thought & Reasoning)
CREATE TABLE IF NOT EXISTS ai_thinking_traces (
  id               SERIAL PRIMARY KEY,
  trace_id         UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thinking_content TEXT,
  reasoning_steps  JSONB NOT NULL DEFAULT '[]',
  tool_calls       JSONB NOT NULL DEFAULT '[]',
  final_action     VARCHAR(100),
  confidence_score NUMERIC(4,3),
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  latency_ms       INTEGER,
  model_name       VARCHAR(100),
  policy_flags     JSONB NOT NULL DEFAULT '[]',
  guardrail_result VARCHAR(50) CHECK (guardrail_result IN ('pass','block','warn') OR guardrail_result IS NULL),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE ai_thinking_traces IS 'Detailed chain-of-thought and reasoning traces per AI turn';

CREATE INDEX idx_ai_traces_conv_time ON ai_thinking_traces(conversation_id, created_at DESC);
CREATE INDEX idx_ai_traces_project_time ON ai_thinking_traces(project_id, created_at DESC);

-- 3. AI MEMORY (Long-Term Memory per Profile/Project)
CREATE TABLE IF NOT EXISTS ai_memory (
  id               SERIAL PRIMARY KEY,
  profile_id       INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  memory_type      VARCHAR(50) NOT NULL CHECK (memory_type IN ('preference','fact','issue','resolution','context')),
  memory_scope     VARCHAR(50) NOT NULL DEFAULT 'conversation' CHECK (memory_scope IN ('conversation','issue','customer','project')),
  key              VARCHAR(255) NOT NULL,
  value            TEXT NOT NULL,
  value_embedding  TEXT,
  embedding_model  VARCHAR(100) DEFAULT 'text-embedding-3-small',
  source_conv_id   INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  source_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  confidence       NUMERIC(3,2) NOT NULL DEFAULT 1.00,
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TIMESTAMPTZ,
  is_verified      BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE ai_memory IS 'Long-term cross-conversation memories extracted by PromptX';

CREATE INDEX idx_ai_memory_profile_project ON ai_memory(profile_id, project_id) WHERE profile_id IS NOT NULL;
CREATE INDEX idx_ai_memory_type ON ai_memory(project_id, memory_type, key);
CREATE INDEX idx_ai_memory_ticket ON ai_memory(source_ticket_id, memory_scope) WHERE source_ticket_id IS NOT NULL;
