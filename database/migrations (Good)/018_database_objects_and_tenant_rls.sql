-- ============================================================
-- TicketX / PromptX Platform — Migration 018: Database Objects & Tenant RLS
-- Purpose: Install the modular helper functions, runtime-compatible RLS,
--          updated_at triggers, and reporting views through the tracked runner.
-- MUST RUN AFTER: 017_architectural_corrections.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Columns required by the modular triggers and reporting read models.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE identities ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE project_channels ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE project_prompts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS sla_response_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_resolve_due_at TIMESTAMPTZ;
UPDATE tickets SET sla_resolve_due_at = due_date WHERE sla_resolve_due_at IS NULL AND due_date IS NOT NULL;

ALTER TABLE traces
  ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS model_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS input_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS output_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10,6),
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER;

-- Messages are tenant-scoped through their conversation. Persist the resolved
-- project id so RLS remains efficient without requiring backend callers to send it.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS project_id INTEGER;
UPDATE messages m
SET project_id = c.project_id
FROM conversations c
WHERE c.id = m.conversation_id
  AND m.project_id IS DISTINCT FROM c.project_id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM messages WHERE project_id IS NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = 'Cannot enable message tenant isolation because messages without a project exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'messages'::regclass
      AND conname = 'messages_project_id_fkey'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE messages ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_project_created ON messages(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_traces_project_time ON traces(project_id, called_at DESC) WHERE project_id IS NOT NULL;

CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS UUID AS $$
DECLARE
  unix_ts_ms BYTEA;
  uuid_bytes BYTEA;
BEGIN
  unix_ts_ms := substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);
  uuid_bytes := uuid_send(gen_random_uuid());
  uuid_bytes := overlay(uuid_bytes placing unix_ts_ms from 1 for 6);
  uuid_bytes := set_bit(uuid_bytes, 52, 1);
  uuid_bytes := set_bit(uuid_bytes, 53, 1);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END $$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION set_message_project_id()
RETURNS TRIGGER AS $$
BEGIN
  SELECT project_id INTO NEW.project_id
  FROM conversations
  WHERE id = NEW.conversation_id;

  IF NEW.project_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Message conversation does not resolve to a project';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_search_knowledge_documents(
  p_project_id INT,
  p_embedding TEXT,
  p_match_threshold FLOAT,
  p_match_count INT
)
RETURNS TABLE (document_id UUID, title VARCHAR, content TEXT, similarity FLOAT) AS $$
BEGIN
  RETURN QUERY
  SELECT kd.id, kd.title, kd.raw_content, 1.0::FLOAT
  FROM knowledge_documents kd
  WHERE kd.project_id = p_project_id
    AND kd.is_active = TRUE
    AND kd.deleted_at IS NULL
  LIMIT p_match_count;
END;
$$ LANGUAGE plpgsql STABLE;

DROP TRIGGER IF EXISTS trg_messages_project_id ON messages;
CREATE TRIGGER trg_messages_project_id
BEFORE INSERT OR UPDATE OF conversation_id ON messages
FOR EACH ROW EXECUTE FUNCTION set_message_project_id();

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_channels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_conversations_tenant_isolation ON conversations;
CREATE POLICY p_conversations_tenant_isolation ON conversations FOR ALL
USING (
  NULLIF(current_setting('app.current_project_id', TRUE), '') IS NULL
  OR project_id = NULLIF(current_setting('app.current_project_id', TRUE), '')::INT
);

DROP POLICY IF EXISTS p_messages_tenant_isolation ON messages;
CREATE POLICY p_messages_tenant_isolation ON messages FOR ALL
USING (
  NULLIF(current_setting('app.current_project_id', TRUE), '') IS NULL
  OR project_id = NULLIF(current_setting('app.current_project_id', TRUE), '')::INT
);

DROP POLICY IF EXISTS p_tickets_tenant_isolation ON tickets;
CREATE POLICY p_tickets_tenant_isolation ON tickets FOR ALL
USING (
  NULLIF(current_setting('app.current_project_id', TRUE), '') IS NULL
  OR project_id = NULLIF(current_setting('app.current_project_id', TRUE), '')::INT
);

DROP POLICY IF EXISTS p_knowledge_docs_tenant_isolation ON knowledge_documents;
CREATE POLICY p_knowledge_docs_tenant_isolation ON knowledge_documents FOR ALL
USING (
  NULLIF(current_setting('app.current_project_id', TRUE), '') IS NULL
  OR project_id = NULLIF(current_setting('app.current_project_id', TRUE), '')::INT
);

DROP POLICY IF EXISTS p_project_channels_tenant_isolation ON project_channels;
CREATE POLICY p_project_channels_tenant_isolation ON project_channels FOR ALL
USING (
  NULLIF(current_setting('app.current_project_id', TRUE), '') IS NULL
  OR project_id = NULLIF(current_setting('app.current_project_id', TRUE), '')::INT
);

DROP TRIGGER IF EXISTS trg_companies_updated_at ON companies;
CREATE TRIGGER trg_companies_updated_at BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;
CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_teams_updated_at ON teams;
CREATE TRIGGER trg_teams_updated_at BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_operators_updated_at ON operators;
CREATE TRIGGER trg_operators_updated_at BEFORE UPDATE ON operators FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_profiles_updated_at ON profiles;
CREATE TRIGGER trg_profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_identities_updated_at ON identities;
CREATE TRIGGER trg_identities_updated_at BEFORE UPDATE ON identities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_project_channels_updated_at ON project_channels;
CREATE TRIGGER trg_project_channels_updated_at BEFORE UPDATE ON project_channels FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_project_prompts_updated_at ON project_prompts;
CREATE TRIGGER trg_project_prompts_updated_at BEFORE UPDATE ON project_prompts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_conversations_updated_at ON conversations;
CREATE TRIGGER trg_conversations_updated_at BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_tickets_updated_at ON tickets;
CREATE TRIGGER trg_tickets_updated_at BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_internal_notes_updated_at ON internal_notes;
CREATE TRIGGER trg_internal_notes_updated_at BEFORE UPDATE ON internal_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_knowledge_docs_updated_at ON knowledge_documents;
CREATE TRIGGER trg_knowledge_docs_updated_at BEFORE UPDATE ON knowledge_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_ai_memory_updated_at ON ai_memory;
CREATE TRIGGER trg_ai_memory_updated_at BEFORE UPDATE ON ai_memory FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_webhook_events_updated_at ON webhook_events;
CREATE TRIGGER trg_webhook_events_updated_at BEFORE UPDATE ON webhook_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE VIEW v_active_inbox AS
SELECT c.id AS conversation_id, c.project_id, c.channel,
       c.status AS conversation_status, c.handled_by, c.takeover_state,
       c.operator_id, op.name AS operator_name, i.channel_ref,
       p.id AS profile_id, p.name AS customer_name, p.email AS customer_email,
       t.id AS ticket_id, t.ticket_id AS ticket_code,
       t.status AS ticket_status, t.priority AS ticket_priority,
       c.last_message_at, c.created_at AS conversation_created_at
FROM conversations c
LEFT JOIN operators op ON op.id = c.operator_id
LEFT JOIN identities i ON i.id = c.identity_id
LEFT JOIN profiles p ON p.id = i.profile_id
LEFT JOIN conversation_ticket_links ctl ON ctl.conversation_id = c.id AND ctl.link_type = 'primary'
LEFT JOIN tickets t ON t.id = ctl.ticket_id
WHERE c.deleted_at IS NULL AND lower(c.status) IN ('open','pending','escalated');

CREATE OR REPLACE VIEW v_ticket_sla_status AS
SELECT t.id AS ticket_id, t.ticket_id AS ticket_code, t.project_id,
       t.subject, t.status, t.priority, t.operator_id,
       op.name AS operator_name, t.created_at, t.due_date,
       t.sla_response_due_at, t.sla_resolve_due_at, t.sla_breached,
       CASE
         WHEN lower(t.status) IN ('resolved','closed','cancelled') THEN 'COMPLETED'
         WHEN NOW() > COALESCE(t.sla_resolve_due_at, t.due_date) THEN 'RESOLVE_BREACHED'
         WHEN NOW() > t.sla_response_due_at AND t.first_response_at IS NULL THEN 'RESPONSE_BREACHED'
         ELSE 'WITHIN_SLA'
       END AS sla_state
FROM tickets t
LEFT JOIN operators op ON op.id = t.operator_id
WHERE t.deleted_at IS NULL;

CREATE OR REPLACE VIEW v_ai_cost_analytics AS
SELECT tr.project_id, p.name AS project_name,
       DATE_TRUNC('day', tr.called_at) AS log_date, tr.model_name,
       COUNT(tr.id) AS total_calls,
       SUM(COALESCE(tr.input_tokens, 0)) AS total_input_tokens,
       SUM(COALESCE(tr.output_tokens, 0)) AS total_output_tokens,
       SUM(COALESCE(tr.cost_usd, 0.00)) AS total_cost_usd,
       AVG(tr.latency_ms) AS avg_latency_ms
FROM traces tr
LEFT JOIN projects p ON p.id = tr.project_id
GROUP BY tr.project_id, p.name, DATE_TRUNC('day', tr.called_at), tr.model_name;
