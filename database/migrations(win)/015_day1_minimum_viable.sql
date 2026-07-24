-- ============================================================
-- TicketX / PromptX Platform — Migration 015: Day 1 Minimum Viable
-- /database/migrations/015_day1_minimum_viable.sql
-- Author: Database Architecture Audit
-- Date: 2026-07-21
-- Purpose: Adds webhook_events (idempotency), knowledge tables, soft delete, GDPR
-- MUST RUN AFTER: 014_production_readiness.sql
-- ============================================================

-- 0. HELPER FUNCTIONS REQUIRED FOR MIGRATION
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

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

-- 1. WEBHOOK EVENTS (Ingestion Idempotency Aggregate Root)
CREATE TABLE IF NOT EXISTS webhook_events (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  platform          VARCHAR(50) NOT NULL CHECK (platform IN ('line','line_group','whatsapp','facebook','instagram','email','webchat','internal','unknown')),
  channel_type      VARCHAR(50),
  channel_id        VARCHAR(255),
  platform_event_id VARCHAR(500),
  idempotency_key   VARCHAR(500) NOT NULL UNIQUE,
  raw_payload       JSONB NOT NULL,
  http_headers      JSONB NOT NULL DEFAULT '{}',
  hmac_signature    TEXT,
  hmac_valid        BOOLEAN,
  status            VARCHAR(50) NOT NULL DEFAULT 'received' CHECK (status IN ('received','queued','processing','processed','failed','duplicate','skipped','replayed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  last_error        TEXT,
  next_retry_at     TIMESTAMPTZ,
  processed_at      TIMESTAMPTZ,
  bullmq_job_id     VARCHAR(255),
  resulting_conv_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  ip_address        INET,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_status_retry ON webhook_events(status, next_retry_at ASC) WHERE status IN ('received','failed');
CREATE INDEX IF NOT EXISTS idx_webhook_platform_event ON webhook_events(platform, platform_event_id) WHERE platform_event_id IS NOT NULL;

-- 2. KNOWLEDGE DOCUMENTS & EMBEDDINGS (RAG Knowledge Base)
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  external_doc_id   VARCHAR(255),
  title             VARCHAR(500) NOT NULL,
  raw_content       TEXT NOT NULL,
  processed_content TEXT,
  document_type     VARCHAR(50) NOT NULL DEFAULT 'knowledge' CHECK (document_type IN ('faq','manual','policy','procedure','ticket_resolution','conversation_summary','product_spec','legal','sop','other')),
  language          VARCHAR(20) NOT NULL DEFAULT 'th',
  source_url        TEXT,
  chunk_index       INTEGER NOT NULL DEFAULT 0,
  chunk_total       INTEGER NOT NULL DEFAULT 1,
  parent_doc_id     UUID REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL DEFAULT 1,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  indexed_at        TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_by        INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ,
  UNIQUE (project_id, external_doc_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS knowledge_embeddings (
  id            SERIAL PRIMARY KEY,
  document_id   UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  model_name    VARCHAR(150) NOT NULL DEFAULT 'text-embedding-3-small',
  model_version VARCHAR(50),
  dimensions    INTEGER NOT NULL DEFAULT 1536,
  embedding     TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2.1 CONVERSATION HANDOFFS (AI-to-Human Handover Logs)
CREATE TABLE IF NOT EXISTS conversation_handoffs (
  id               SERIAL PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_owner       VARCHAR(20) NOT NULL CHECK (from_owner IN ('ai','human','system')),
  to_owner         VARCHAR(20) NOT NULL CHECK (to_owner IN ('ai','human','system')),
  from_operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  to_operator_id   INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  trigger_type     VARCHAR(50) NOT NULL DEFAULT 'unknown' CHECK (trigger_type IN ('customer_request','ai_escalation','operator_claim','operator_release','timeout_expired','force_release','sla_breach','system')),
  reason           TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ,
  context_snapshot JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_handoffs_conversation ON conversation_handoffs(conversation_id, started_at DESC);

-- 3. SOFT DELETE COLUMNS
ALTER TABLE conversations  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE messages       ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE tickets        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE operators      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE identities     ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE profiles       ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE companies      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE projects       ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 4. GDPR COLUMNS
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS gdpr_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gdpr_erased_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_pii_erased   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS data_region     VARCHAR(20) NOT NULL DEFAULT 'TH';

ALTER TABLE identities
  ADD COLUMN IF NOT EXISTS gdpr_erased_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_pii          BOOLEAN NOT NULL DEFAULT TRUE;

-- 5. COMPANY & PROJECT SLUG / STATUS
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS slug VARCHAR(100),
  ADD COLUMN IF NOT EXISTS plan_tier VARCHAR(50) NOT NULL DEFAULT 'starter',
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'active';

UPDATE companies SET slug = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || id::text WHERE slug IS NULL;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS slug VARCHAR(100),
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(100) NOT NULL DEFAULT 'Asia/Bangkok';

UPDATE projects SET slug = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || id::text WHERE slug IS NULL;

-- 6. PROMPT VERSIONING
ALTER TABLE project_prompts
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS version_label VARCHAR(100),
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS ab_weight NUMERIC(5,2) NOT NULL DEFAULT 100.00;

-- 7. ENCRYPTED CREDENTIAL COLUMNS
ALTER TABLE project_channels
  ADD COLUMN IF NOT EXISTS secret_token_encrypted BYTEA,
  ADD COLUMN IF NOT EXISTS credentials_encrypted BYTEA,
  ADD COLUMN IF NOT EXISTS encryption_key_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS encrypted_at TIMESTAMPTZ;
