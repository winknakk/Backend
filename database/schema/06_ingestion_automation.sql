-- ============================================================
-- TicketX / PromptX Platform — Ingestion, Automation & Operations Schema
-- /database/schema/06_ingestion_automation.sql
-- Target Database: PostgreSQL 16+
-- ============================================================

-- 1. WEBHOOK EVENTS (Ingestion Context Aggregate Root)
CREATE TABLE IF NOT EXISTS webhook_events (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id           INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  platform             VARCHAR(50) NOT NULL CHECK (platform IN ('line','line_group','whatsapp','facebook','instagram','email','webchat','internal','unknown')),
  channel_type         VARCHAR(50),
  channel_id           VARCHAR(255),
  platform_event_id    VARCHAR(500),
  idempotency_key      VARCHAR(500) NOT NULL UNIQUE,
  raw_payload          JSONB NOT NULL,
  http_headers         JSONB NOT NULL DEFAULT '{}',
  hmac_signature       TEXT,
  hmac_valid           BOOLEAN,
  status               VARCHAR(50) NOT NULL DEFAULT 'received' CHECK (status IN ('received','queued','processing','processed','failed','duplicate','skipped','replayed')),
  attempts             INTEGER NOT NULL DEFAULT 0,
  max_attempts         INTEGER NOT NULL DEFAULT 3,
  last_error           TEXT,
  next_retry_at        TIMESTAMPTZ,
  processed_at         TIMESTAMPTZ,
  bullmq_job_id        VARCHAR(255),
  resulting_conv_id    INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  ip_address           INET,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE webhook_events IS 'Ingestion Context Aggregate Root — provides zero-latency webhook storage and idempotency';

CREATE INDEX idx_webhook_status_retry ON webhook_events(status, next_retry_at ASC) WHERE status IN ('received','failed');
CREATE INDEX idx_webhook_platform_event ON webhook_events(platform, platform_event_id) WHERE platform_event_id IS NOT NULL;
CREATE INDEX idx_webhook_project_time ON webhook_events(project_id, received_at DESC) WHERE project_id IS NOT NULL;

-- 2. OUTBOX EVENTS (Automation Context Aggregate Root / Transactional Outbox)
CREATE TABLE IF NOT EXISTS outbox_events (
  id             SERIAL PRIMARY KEY,
  event_type     VARCHAR(255) NOT NULL,
  aggregate_type VARCHAR(100),
  aggregate_id   VARCHAR(255),
  project_id     INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  payload        JSONB NOT NULL DEFAULT '{}',
  status         VARCHAR(50) NOT NULL DEFAULT 'pending',
  attempts       INT NOT NULL DEFAULT 0,
  last_error     TEXT,
  next_retry_at  TIMESTAMPTZ,
  processed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE outbox_events IS 'Transactional Outbox pattern table for atomic event publication';

CREATE INDEX idx_outbox_status_retry ON outbox_events(status, next_retry_at ASC NULLS FIRST) WHERE status IN ('pending','failed');
CREATE INDEX idx_outbox_aggregate ON outbox_events(aggregate_type, aggregate_id) WHERE aggregate_id IS NOT NULL;

-- 3. CONVERSATION EVENTS (State Transition Log)
CREATE TABLE IF NOT EXISTS conversation_events (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  event_type      VARCHAR(100) NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. ADMIN AUDIT LOGS
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id          SERIAL PRIMARY KEY,
  operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  action      VARCHAR(255) NOT NULL,
  details     JSONB NOT NULL DEFAULT '{}',
  ip_address  INET,
  user_agent  TEXT,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE admin_audit_logs IS 'System audit log for administrative setting changes and security actions';

CREATE INDEX idx_audit_project_time ON admin_audit_logs(project_id, timestamp DESC);
CREATE INDEX idx_audit_operator ON admin_audit_logs(operator_id, timestamp DESC) WHERE operator_id IS NOT NULL;
