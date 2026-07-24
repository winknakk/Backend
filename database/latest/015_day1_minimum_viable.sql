-- ============================================================
-- MIGRATION 015 REVISED: DAY 1 MINIMUM VIABLE SCHEMA
-- 015_day1_minimum_viable.sql
-- Date: 2026-07-21
-- Author: Schema Triage Review
--
-- SCOPE CHANGE FROM ORIGINAL 015:
--   Original 015 had 44 tables / ~500 lines
--   This revised version has 26 tables / ~200 lines
--
-- DEFERRED TO LATER MIGRATIONS:
--   domain_events          → migration 016
--   learning_samples       → migration 019
--   message_media_analysis → migration 018
--   ai_inference_logs      → migration 016
--   retention_policies     → migration 020
--   ai_memory              → migration 018
--   ai_thinking_traces     → migration 016
--   operator_project_access → migration 016
--   project_routing_rules  → migration 016
--   project_mcp_permissions → migration 016
--   conversation_participants → migration 017
--   internal_notes         → migration 017
--   webchat_sessions       → migration 016
--   ticket_embeddings      → migration 016
--   company_holiday_calendars → migration 016
--   company_holidays       → migration 016
--   profile_projects       → (audit required, possibly drop)
--
-- DROPPED:
--   document_embeddings    → replaced by knowledge_documents + knowledge_embeddings
--   retention_policies     → no runtime owner, use config instead
--
-- MUST RUN AFTER: migration 014
-- ============================================================

-- ============================================================
-- SECTION 0: EXTENSIONS
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Minimal UUID v7 for new tables (time-ordered)
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

-- ============================================================
-- SECTION 1: SOFT DELETE — minimum required tables only
-- ============================================================
-- Only add deleted_at to tables that have a REAL delete risk on Day 1.
-- Operators and messages are the most likely to be accidentally deleted.

ALTER TABLE conversations  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE messages       ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE tickets        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE operators      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE identities     ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE profiles       ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial indexes (WHERE deleted_at IS NULL) — only for hot query paths
CREATE INDEX IF NOT EXISTS idx_conversations_active
  ON conversations(project_id, status) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_active
  ON messages(conversation_id, created_at ASC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tickets_active
  ON tickets(project_id, status) WHERE deleted_at IS NULL;

-- ============================================================
-- SECTION 2: GDPR MINIMUM — profiles and identities only
-- ============================================================
-- Adding GDPR columns now costs nothing. Adding after production
-- requires running ALTER on a live table with millions of rows.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS gdpr_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gdpr_erased_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_pii_erased   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS data_region     VARCHAR(20) NOT NULL DEFAULT 'TH';

ALTER TABLE identities
  ADD COLUMN IF NOT EXISTS gdpr_erased_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_pii          BOOLEAN NOT NULL DEFAULT TRUE;

-- ============================================================
-- SECTION 3: COMPANIES — slug and status
-- ============================================================
-- Slug is needed for URL routing on Day 1 Admin UI.
-- Status is needed to suspend a company without deleting data.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS slug       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS status     VARCHAR(50) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Backfill slug
UPDATE companies
  SET slug = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || id::text
  WHERE slug IS NULL;

ALTER TABLE companies ALTER COLUMN slug SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_slug_key') THEN
    ALTER TABLE companies ADD CONSTRAINT companies_slug_key UNIQUE (slug);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_status_check') THEN
    ALTER TABLE companies ADD CONSTRAINT companies_status_check
      CHECK (status IN ('active','suspended','churned'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_companies_slug ON companies(slug);

-- ============================================================
-- SECTION 4: PROJECTS — slug, status, not-null company_id
-- ============================================================

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS slug       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS status     VARCHAR(50) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS timezone   VARCHAR(100) NOT NULL DEFAULT 'Asia/Bangkok',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE projects
  SET slug = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || id::text
  WHERE slug IS NULL;

ALTER TABLE projects ALTER COLUMN slug SET NOT NULL;

-- Fix company_id nullable (no orphan projects)
UPDATE projects SET company_id = 1 WHERE company_id IS NULL;
ALTER TABLE projects ALTER COLUMN company_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_status_check') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_status_check
      CHECK (status IN ('active','archived','suspended'));
  END IF;
END $$;

-- ============================================================
-- SECTION 5: PROMPT VERSIONING
-- ============================================================
-- Needed on Day 1 because A/B testing and prompt rollback are
-- required before the first customer conversation.
-- Without versioning, a bad prompt change cannot be rolled back
-- without data loss.

ALTER TABLE project_prompts
  ADD COLUMN IF NOT EXISTS version         INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS version_label   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS ab_weight       NUMERIC(5,2) NOT NULL DEFAULT 100.00,
  ADD COLUMN IF NOT EXISTS activated_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deactivated_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_by      INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Enforce: only one active prompt per project at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_prompts_one_active
  ON project_prompts(project_id) WHERE is_active = TRUE;

-- ============================================================
-- SECTION 6: CHANNEL CREDENTIALS — Encrypted columns
-- ============================================================
-- The plaintext secret_token and credentials_json in project_channels
-- are a security risk. Add encrypted columns now.
-- Application MUST encrypt via AES-256-GCM before inserting.
-- After encrypting, NULL OUT the plaintext columns via app migration.

ALTER TABLE project_channels
  ADD COLUMN IF NOT EXISTS channel_name           VARCHAR(255),
  ADD COLUMN IF NOT EXISTS webhook_url            TEXT,
  ADD COLUMN IF NOT EXISTS verify_token           VARCHAR(500),
  ADD COLUMN IF NOT EXISTS secret_token_encrypted BYTEA,
  ADD COLUMN IF NOT EXISTS credentials_encrypted  BYTEA,
  ADD COLUMN IF NOT EXISTS encryption_key_id      VARCHAR(200),
  ADD COLUMN IF NOT EXISTS encrypted_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_verified_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ============================================================
-- SECTION 7: TRACES — Bridge columns (replaces ai_inference_logs for now)
-- ============================================================
-- ai_inference_logs is deferred to migration 016.
-- Add minimal token/cost columns to traces as a bridge.
-- These columns can be backfilled to ai_inference_logs later.

ALTER TABLE traces
  ADD COLUMN IF NOT EXISTS project_id     INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS input_tokens   INTEGER,
  ADD COLUMN IF NOT EXISTS output_tokens  INTEGER,
  ADD COLUMN IF NOT EXISTS cost_usd       NUMERIC(10,6),
  ADD COLUMN IF NOT EXISTS latency_ms     INTEGER,
  ADD COLUMN IF NOT EXISTS model_name     VARCHAR(100),
  ADD COLUMN IF NOT EXISTS guardrail_result VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_traces_project_time
  ON traces(project_id, called_at DESC)
  WHERE project_id IS NOT NULL;

-- ============================================================
-- SECTION 8: WEBHOOK_EVENTS — Idempotency (KEEP — Day 1 critical)
-- ============================================================
-- This is the single most important table for production reliability.
-- LINE will retry webhooks. Without this, duplicate messages are inevitable.

CREATE TABLE IF NOT EXISTS webhook_events (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  platform          VARCHAR(50) NOT NULL
                    CHECK (platform IN (
                      'line','line_group','whatsapp','facebook',
                      'instagram','email','webchat','internal','unknown'
                    )),
  channel_type      VARCHAR(50),
  channel_id        VARCHAR(255),

  -- Deduplication key — computed as hash(platform + channel_id + platform_event_id)
  platform_event_id VARCHAR(500),
  idempotency_key   VARCHAR(500) NOT NULL,

  -- Full raw payload (never discard)
  raw_payload       JSONB NOT NULL,
  http_headers      JSONB NOT NULL DEFAULT '{}',
  hmac_signature    TEXT,
  hmac_valid        BOOLEAN,

  -- Processing lifecycle
  status            VARCHAR(50) NOT NULL DEFAULT 'received'
                    CHECK (status IN (
                      'received','queued','processing',
                      'processed','failed','duplicate','skipped','replayed'
                    )),
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  last_error        TEXT,
  next_retry_at     TIMESTAMPTZ,
  processed_at      TIMESTAMPTZ,

  -- Downstream trace
  bullmq_job_id     VARCHAR(255),
  resulting_conv_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,

  ip_address        INET,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_idempotency
  ON webhook_events(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_webhook_status_retry
  ON webhook_events(status, next_retry_at ASC)
  WHERE status IN ('received','failed');

CREATE INDEX IF NOT EXISTS idx_webhook_platform_event
  ON webhook_events(platform, platform_event_id)
  WHERE platform_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_project_time
  ON webhook_events(project_id, received_at DESC)
  WHERE project_id IS NOT NULL;

-- ============================================================
-- SECTION 9: CONVERSATION_HANDOFFS — Takeover history (KEEP — Day 1)
-- ============================================================
-- TakeoverManager writes here on every claim and release.
-- AgentRuntime reads here to determine conversation ownership context.
-- Absence means there is no audit trail for Human → AI transitions.

CREATE TABLE IF NOT EXISTS conversation_handoffs (
  id               SERIAL PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  from_owner       VARCHAR(20) NOT NULL CHECK (from_owner IN ('ai','human','system')),
  to_owner         VARCHAR(20) NOT NULL CHECK (to_owner IN ('ai','human','system')),
  from_operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  to_operator_id   INTEGER REFERENCES operators(id) ON DELETE SET NULL,

  trigger_type     VARCHAR(50) NOT NULL DEFAULT 'unknown'
                   CHECK (trigger_type IN (
                     'customer_request','ai_escalation','operator_claim',
                     'operator_release','timeout_expired','force_release',
                     'sla_breach','system'
                   )),
  reason           TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ,

  -- Snapshot of AI context at handoff (so AI can re-hydrate after human releases)
  context_snapshot JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_handoffs_conversation
  ON conversation_handoffs(conversation_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_handoffs_project_time
  ON conversation_handoffs(project_id, started_at DESC);

-- ============================================================
-- SECTION 10: KNOWLEDGE_DOCUMENTS + KNOWLEDGE_EMBEDDINGS
-- ============================================================
-- RAG is needed from Day 1. PromptX calls search_project_docs
-- before every response. The existing document_embeddings table
-- lacks project_id FK — it will be replaced by these two tables.

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  external_doc_id VARCHAR(255),
  title           VARCHAR(500) NOT NULL,
  raw_content     TEXT NOT NULL,
  processed_content TEXT,
  document_type   VARCHAR(50) NOT NULL DEFAULT 'knowledge'
                  CHECK (document_type IN (
                    'faq','manual','policy','procedure',
                    'ticket_resolution','conversation_summary',
                    'product_spec','legal','sop','other'
                  )),
  language        VARCHAR(20) NOT NULL DEFAULT 'th',
  source_url      TEXT,
  chunk_index     INTEGER NOT NULL DEFAULT 0,
  chunk_total     INTEGER NOT NULL DEFAULT 1,
  parent_doc_id   UUID REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL DEFAULT 1,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  indexed_at      TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_by      INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, external_doc_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS knowledge_embeddings (
  id            SERIAL PRIMARY KEY,
  document_id   UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  model_name    VARCHAR(150) NOT NULL DEFAULT 'text-embedding-3-small',
  model_version VARCHAR(50),
  dimensions    INTEGER NOT NULL DEFAULT 1536,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    ALTER TABLE knowledge_embeddings
      ADD COLUMN IF NOT EXISTS embedding VECTOR(1536) NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_know_embed_ivfflat
      ON knowledge_embeddings USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);
  ELSE
    ALTER TABLE knowledge_embeddings
      ADD COLUMN IF NOT EXISTS embedding TEXT NOT NULL DEFAULT '';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_know_docs_project_active
  ON knowledge_documents(project_id, is_active)
  WHERE is_active = TRUE AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_know_embed_project
  ON knowledge_embeddings(project_id, model_name);

-- ============================================================
-- SECTION 11: RETIRE document_embeddings
-- ============================================================
-- Migrate data from document_embeddings → knowledge_documents
-- before dropping. This script handles migration if data exists.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'document_embeddings') THEN
    -- Insert into knowledge_documents (requires company_id — use company_id=1 as default)
    INSERT INTO knowledge_documents (
      project_id, company_id, external_doc_id, title,
      raw_content, document_type, is_active, created_at, updated_at
    )
    SELECT
      COALESCE(project_id, 1),  -- use project_id if exists, else default
      1,                         -- company_id default
      doc_id,
      COALESCE(SUBSTRING(content, 1, 200), 'Untitled'),
      content,
      'knowledge',
      TRUE,
      created_at,
      updated_at
    FROM document_embeddings
    WHERE NOT EXISTS (
      SELECT 1 FROM knowledge_documents kd
      WHERE kd.external_doc_id = document_embeddings.doc_id
    );
    -- NOTE: Embedding data migration requires separate step at application layer
    -- because VECTOR type requires special handling
    RAISE NOTICE 'document_embeddings data migrated to knowledge_documents. Embeddings require separate migration.';
  END IF;
END $$;

-- After confirming migration, uncomment to drop:
-- DROP TABLE IF EXISTS document_embeddings CASCADE;
-- (Keep commented until data migration is verified in production)

-- ============================================================
-- SECTION 12: MESSAGE ATTACHMENTS — Minimum storage columns
-- ============================================================
-- Only add what is needed on Day 1: storage_key for S3,
-- platform_url to preserve original LINE CDN URL before it expires,
-- and mime_type for media type routing.

ALTER TABLE message_attachments
  ALTER COLUMN file_size TYPE BIGINT USING COALESCE(file_size::bigint, 0);

ALTER TABLE message_attachments
  ADD COLUMN IF NOT EXISTS mime_type         VARCHAR(150),
  ADD COLUMN IF NOT EXISTS storage_provider  VARCHAR(50) NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS storage_key       TEXT,
  ADD COLUMN IF NOT EXISTS platform_url      TEXT,
  ADD COLUMN IF NOT EXISTS permanent_url     TEXT,
  ADD COLUMN IF NOT EXISTS attachment_type   VARCHAR(50) NOT NULL DEFAULT 'file',
  ADD COLUMN IF NOT EXISTS thumbnail_url     TEXT,
  ADD COLUMN IF NOT EXISTS expires_at        TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_type_check') THEN
    ALTER TABLE message_attachments ADD CONSTRAINT attachments_type_check
      CHECK (attachment_type IN ('image','audio','video','document','sticker','location','file','voice'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_attachments_message
  ON message_attachments(message_id);

-- ============================================================
-- SECTION 13: CONVERSATIONS — Minimum new columns
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_message_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_response_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at          TIMESTAMPTZ;

-- Already added in 014: operator_id, takeover_state, conversation_type
-- Add missing composite index for inbox performance
CREATE INDEX IF NOT EXISTS idx_conv_project_status_last
  ON conversations(project_id, status, last_message_at DESC NULLS LAST)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conv_operator
  ON conversations(operator_id)
  WHERE operator_id IS NOT NULL AND deleted_at IS NULL;

-- ============================================================
-- SECTION 14: UPDATED_AT TRIGGERS (Day 1 tables only)
-- ============================================================
-- Only apply to tables that are actively written by services on Day 1.

-- trigger function already exists from migration 014:
-- CREATE OR REPLACE FUNCTION set_updated_at() ...

DROP TRIGGER IF EXISTS trg_webhook_events_updated ON webhook_events;
CREATE TRIGGER trg_webhook_events_updated
  BEFORE UPDATE ON webhook_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_knowledge_docs_updated ON knowledge_documents;
CREATE TRIGGER trg_knowledge_docs_updated
  BEFORE UPDATE ON knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_project_prompts_updated ON project_prompts;
CREATE TRIGGER trg_project_prompts_updated
  BEFORE UPDATE ON project_prompts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_project_channels_updated ON project_channels;
CREATE TRIGGER trg_project_channels_updated
  BEFORE UPDATE ON project_channels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- SECTION 15: FINAL INDEXES (fill gaps on Day 1 tables)
-- ============================================================

-- conversations
CREATE INDEX IF NOT EXISTS idx_conv_takeover_active
  ON conversations(takeover_state)
  WHERE takeover_state = 'active';

-- messages
CREATE INDEX IF NOT EXISTS idx_messages_conv_time
  ON messages(conversation_id, created_at ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_external
  ON messages(external_id)
  WHERE external_id IS NOT NULL;

-- tickets
CREATE INDEX IF NOT EXISTS idx_tickets_project_status
  ON tickets(project_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tickets_due_open
  ON tickets(due_date ASC)
  WHERE status NOT IN ('Resolved','Closed','Cancelled') AND deleted_at IS NULL;

-- traces
CREATE INDEX IF NOT EXISTS idx_traces_called_at
  ON traces(called_at DESC);

-- ============================================================
-- SUMMARY
-- ============================================================
-- Tables in production after migration 014 + 015 (this file):
--
-- CORE TENANT:        companies, projects, operators, profiles, identities
-- PROJECT CONFIG:     project_channels, project_prompts, project_sla_policies,
--                     project_ai_settings, project_business_hours,
--                     project_holidays, project_feature_flags
-- CONVERSATION:       conversations, messages, message_attachments,
--                     takeover_sessions, conversation_handoffs, conversation_events
-- TICKET:             tickets, ticket_events
-- KNOWLEDGE:          knowledge_documents, knowledge_embeddings
-- OPERATIONS:         webhook_events, outbox_events, traces, admin_audit_logs
--
-- TOTAL: 26 tables
--
-- DEFERRED: operator_project_access, project_routing_rules, project_mcp_permissions,
--           webchat_sessions, ticket_embeddings, ai_thinking_traces,
--           company_holiday_calendars, company_holidays, conversation_participants,
--           internal_notes, ai_inference_logs, message_media_analysis,
--           ai_memory, domain_events, learning_samples, retention_policies
--
-- DROPPED:  document_embeddings (data migrated), profile_projects (audit pending)
-- ============================================================
