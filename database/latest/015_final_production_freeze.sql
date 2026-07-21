-- ============================================================
-- MIGRATION 015: FINAL PRODUCTION FREEZE
-- 015_final_production_freeze.sql
-- Date: 2026-07-21
-- Author: Principal Enterprise Architect — Final Architecture Review
-- 
-- PURPOSE:
--   This migration creates all tables required before production.
--   It MUST run after migration 014.
--   Together with 014, this constitutes the production-frozen schema.
--
-- BLOCKING ISSUES RESOLVED:
--   BLOCK-4: webhook_events table (idempotency)
--   BLOCK-8: domain_events table (event sourcing)
--   BLOCK-9: learning_samples + message_media_analysis (AI learning)
--   BLOCK-7: soft delete on all major tables
--   Plus: conversation_handoffs, ai_inference_logs, knowledge tables,
--         observability, retention_policies, prompt versioning
-- ============================================================

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- UUID v7 (time-ordered, sortable — better than gen_random_uuid() for PKs)
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
-- SECTION 1: SOFT DELETE — Add deleted_at to all major tables
-- ============================================================
-- Rule: All queries MUST include WHERE deleted_at IS NULL
-- Rule: Never hard DELETE from these tables — set deleted_at = NOW()

ALTER TABLE companies     ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE projects      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE profiles      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE identities    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE operators     ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE tickets       ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE messages      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial indexes for soft-delete performance
CREATE INDEX IF NOT EXISTS idx_companies_active  ON companies(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_projects_active   ON projects(company_id, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_operators_active  ON operators(company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_active    ON tickets(project_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_active   ON messages(conversation_id, created_at ASC) WHERE deleted_at IS NULL;

-- ============================================================
-- SECTION 2: GDPR / PII COLUMNS
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS gdpr_consent_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gdpr_erased_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_pii_erased     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS data_region       VARCHAR(20) NOT NULL DEFAULT 'TH';

ALTER TABLE identities
  ADD COLUMN IF NOT EXISTS gdpr_erased_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_pii            BOOLEAN NOT NULL DEFAULT TRUE;

-- ============================================================
-- SECTION 3: COMPANIES — Add enterprise columns
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS slug       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS plan_tier  VARCHAR(50) NOT NULL DEFAULT 'starter',
  ADD COLUMN IF NOT EXISTS status     VARCHAR(50) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS settings   JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Backfill slug from name (slugify)
UPDATE companies
SET slug = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))
WHERE slug IS NULL;

-- Make slug NOT NULL after backfill
ALTER TABLE companies ALTER COLUMN slug SET NOT NULL;

-- Add unique constraint on slug
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_slug_key') THEN
    ALTER TABLE companies ADD CONSTRAINT companies_slug_key UNIQUE (slug);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_plan_tier_check') THEN
    ALTER TABLE companies ADD CONSTRAINT companies_plan_tier_check
      CHECK (plan_tier IN ('starter','professional','enterprise'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_status_check') THEN
    ALTER TABLE companies ADD CONSTRAINT companies_status_check
      CHECK (status IN ('active','suspended','churned'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_companies_slug   ON companies(slug);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status) WHERE deleted_at IS NULL;

-- ============================================================
-- SECTION 4: PROJECTS — Add missing columns
-- ============================================================

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS slug      VARCHAR(100),
  ADD COLUMN IF NOT EXISTS status    VARCHAR(50) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS timezone  VARCHAR(100) NOT NULL DEFAULT 'Asia/Bangkok',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Backfill slug
UPDATE projects
SET slug = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || id::text
WHERE slug IS NULL;

ALTER TABLE projects ALTER COLUMN slug SET NOT NULL;

-- Make company_id NOT NULL (no orphan projects allowed)
UPDATE projects SET company_id = 1 WHERE company_id IS NULL;
ALTER TABLE projects ALTER COLUMN company_id SET NOT NULL;

-- Add FK cascade
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints
    WHERE constraint_name = 'projects_company_id_fkey'
    AND delete_rule = 'CASCADE'
  ) THEN
    -- Recreate FK with CASCADE (drop old then add new)
    -- Note: Only do this if constraint exists without cascade
    NULL; -- Manual review required here — depends on existing FK name
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_status_check') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_status_check
      CHECK (status IN ('active','archived','suspended'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(company_id, status) WHERE deleted_at IS NULL;

-- ============================================================
-- SECTION 5: PROMPT VERSIONING — Support A/B testing
-- ============================================================

ALTER TABLE project_prompts
  ADD COLUMN IF NOT EXISTS version       INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS version_label VARCHAR(100),            -- 'v1','v2-formal','v2-casual'
  ADD COLUMN IF NOT EXISTS is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS ab_weight     NUMERIC(5,2) DEFAULT 100.00, -- traffic split %
  ADD COLUMN IF NOT EXISTS activated_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_by    INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Only one active prompt per project
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_prompts_one_active
  ON project_prompts(project_id) WHERE is_active = TRUE;

-- ============================================================
-- SECTION 6: WEBHOOK_EVENTS — Idempotency + Replay capability
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_events (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,

  -- Source
  platform          VARCHAR(50) NOT NULL
                    CHECK (platform IN (
                      'line','whatsapp','facebook','instagram',
                      'email','webchat','internal','unknown'
                    )),
  channel_type      VARCHAR(50),
  channel_id        VARCHAR(255),

  -- Deduplication (CRITICAL for LINE webhook retry)
  platform_event_id VARCHAR(500),
  idempotency_key   VARCHAR(500) NOT NULL,    -- hash(platform + channel_id + platform_event_id)

  -- Full payload (never discard)
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

  -- Traceability to downstream
  bullmq_job_id     VARCHAR(255),
  resulting_message_id UUID,                  -- set after message created from this webhook
  resulting_conv_id    UUID,

  -- Metadata
  ip_address        INET,
  request_id        VARCHAR(255),
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

CREATE INDEX IF NOT EXISTS idx_webhook_unprocessed
  ON webhook_events(received_at)
  WHERE status = 'received';

-- ============================================================
-- SECTION 7: DOMAIN_EVENTS — Event sourcing (append-only)
-- ============================================================
-- IMPORTANT: This table is APPEND-ONLY.
-- Never UPDATE or DELETE rows.
-- Add a database-level rule to enforce this.

CREATE TABLE IF NOT EXISTS domain_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  event_id        UUID UNIQUE NOT NULL DEFAULT uuid_generate_v7(),

  -- Event taxonomy: {domain}.{entity}.{action}.{version}
  -- Examples:
  --   conversation.message.created.v1
  --   conversation.takeover.acquired.v1
  --   ticket.status.changed.v1
  --   ai.inference.completed.v1
  --   webhook.received.v1
  --   knowledge.document.indexed.v1
  event_type      VARCHAR(200) NOT NULL,
  schema_version  VARCHAR(10) NOT NULL DEFAULT 'v1',

  -- Entity reference
  aggregate_type  VARCHAR(100) NOT NULL,
  aggregate_id    VARCHAR(255) NOT NULL,

  -- Tenant scope
  project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  company_id      INTEGER REFERENCES companies(id) ON DELETE SET NULL,

  -- Actor
  actor_type      VARCHAR(50),
  actor_id        VARCHAR(255),

  -- Causality chain
  correlation_id  UUID,
  causation_id    UUID,              -- event that caused this one
  parent_event_id UUID,

  -- Payload (immutable)
  payload         JSONB NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}',

  -- Global ordering
  sequence_number BIGSERIAL NOT NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforce append-only at DB level
CREATE RULE domain_events_no_update AS ON UPDATE TO domain_events DO INSTEAD NOTHING;
CREATE RULE domain_events_no_delete AS ON DELETE TO domain_events DO INSTEAD NOTHING;

CREATE INDEX IF NOT EXISTS idx_domain_events_aggregate
  ON domain_events(aggregate_type, aggregate_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_domain_events_type
  ON domain_events(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_domain_events_project
  ON domain_events(project_id, created_at DESC)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_domain_events_correlation
  ON domain_events(correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_domain_events_sequence
  ON domain_events(sequence_number);

-- ============================================================
-- SECTION 8: CONVERSATION_HANDOFFS — Full handoff history
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_handoffs (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  from_owner      VARCHAR(20) NOT NULL CHECK (from_owner IN ('ai','human','system')),
  to_owner        VARCHAR(20) NOT NULL CHECK (to_owner IN ('ai','human','system')),
  from_operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  to_operator_id   INTEGER REFERENCES operators(id) ON DELETE SET NULL,

  trigger_type    VARCHAR(50) NOT NULL DEFAULT 'unknown'
                  CHECK (trigger_type IN (
                    'customer_request','ai_escalation','operator_claim',
                    'operator_release','timeout_expired','force_release',
                    'sla_breach','system'
                  )),
  trigger_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  reason          TEXT,

  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,

  -- Context snapshot at time of handoff (for AI context re-hydration)
  context_snapshot JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_handoffs_conversation
  ON conversation_handoffs(conversation_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_handoffs_operator
  ON conversation_handoffs(to_operator_id, started_at DESC)
  WHERE to_operator_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_handoffs_project_time
  ON conversation_handoffs(project_id, started_at DESC);

-- ============================================================
-- SECTION 9: AI_INFERENCE_LOGS — Cost, latency, token tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_inference_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  trace_id        UUID REFERENCES ai_thinking_traces(id) ON DELETE SET NULL,
  operator_id     INTEGER REFERENCES operators(id) ON DELETE SET NULL,

  -- Operation classification
  operation_type  VARCHAR(50) NOT NULL
                  CHECK (operation_type IN (
                    'chat_completion','embedding','vision',
                    'audio_transcription','ocr',
                    'tool_call','rag_search','reranking',
                    'classification','summarization','translation'
                  )),

  -- Model identification
  model_name      VARCHAR(150) NOT NULL,
  model_provider  VARCHAR(50) NOT NULL
                  CHECK (model_provider IN ('openai','google','anthropic','azure','mistral','local')),
  model_version   VARCHAR(50),

  -- Prompt & knowledge version tracking (for A/B and learning)
  prompt_template_id   INTEGER REFERENCES project_prompts(id) ON DELETE SET NULL,
  prompt_version       INTEGER,
  knowledge_snapshot   VARCHAR(100),   -- hash or version of knowledge base at query time
  embedding_model      VARCHAR(100),

  -- Performance metrics
  latency_ms      INTEGER NOT NULL,
  queue_wait_ms   INTEGER,

  -- Token accounting
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  total_tokens    INTEGER GENERATED ALWAYS AS (
    COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
  ) STORED,

  -- Cost
  cost_usd        NUMERIC(10,6),

  -- Quality signals
  confidence_score NUMERIC(4,3),
  guardrail_result VARCHAR(20) CHECK (guardrail_result IN ('pass','warn','block') OR guardrail_result IS NULL),
  rag_docs_retrieved INTEGER,
  rag_top_score    NUMERIC(4,3),

  -- Workflow context
  workflow_run_id  VARCHAR(255),
  workflow_step    VARCHAR(100),

  -- Result summary (not the full response — just classification)
  result_action    VARCHAR(100),   -- 'replied','escalated','created_ticket','search_done'

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()

  -- PARTITION BY RANGE (created_at) -- activate when > 1M rows/month
);

CREATE INDEX IF NOT EXISTS idx_ai_logs_project_time
  ON ai_inference_logs(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_logs_model_time
  ON ai_inference_logs(model_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_logs_operation
  ON ai_inference_logs(project_id, operation_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_logs_cost
  ON ai_inference_logs(project_id, cost_usd DESC)
  WHERE cost_usd IS NOT NULL;

-- ============================================================
-- SECTION 10: KNOWLEDGE TABLES — Renamed + Split from document_embeddings
-- ============================================================

-- NOTE: document_embeddings table still exists for backward compatibility
-- New inserts should go to knowledge_documents + knowledge_embeddings
-- Migrate existing data after stable

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Client-provided stable reference
  external_doc_id VARCHAR(255),

  -- Content
  title           VARCHAR(500) NOT NULL,
  raw_content     TEXT NOT NULL,
  processed_content TEXT,

  -- Classification
  document_type   VARCHAR(50) NOT NULL DEFAULT 'knowledge'
                  CHECK (document_type IN (
                    'faq','manual','policy','procedure',
                    'ticket_resolution','conversation_summary',
                    'product_spec','legal','sop','other'
                  )),
  language        VARCHAR(20) NOT NULL DEFAULT 'th',
  source_url      TEXT,

  -- Chunking
  chunk_index     INTEGER NOT NULL DEFAULT 0,
  chunk_total     INTEGER NOT NULL DEFAULT 1,
  parent_doc_id   UUID REFERENCES knowledge_documents(id) ON DELETE CASCADE,

  -- Versioning
  version         INTEGER NOT NULL DEFAULT 1,
  superseded_by   UUID REFERENCES knowledge_documents(id) ON DELETE SET NULL,

  -- State
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

  -- Conditional vector type
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add embedding column conditionally
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    ALTER TABLE knowledge_embeddings
      ADD COLUMN IF NOT EXISTS embedding VECTOR(1536) NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_know_embed_ivfflat
      ON knowledge_embeddings USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 200);
  ELSE
    ALTER TABLE knowledge_embeddings
      ADD COLUMN IF NOT EXISTS embedding TEXT NOT NULL DEFAULT '';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_know_docs_project
  ON knowledge_documents(project_id, is_active)
  WHERE is_active = TRUE AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_know_docs_type
  ON knowledge_documents(project_id, document_type)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_know_embed_project
  ON knowledge_embeddings(project_id, model_name);

-- ============================================================
-- SECTION 11: LEARNING_SAMPLES — AI Training Pipeline
-- ============================================================

CREATE TABLE IF NOT EXISTS learning_samples (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  sample_type     VARCHAR(50) NOT NULL
                  CHECK (sample_type IN (
                    'conversation_resolution',
                    'human_takeover_thread',
                    'ticket_resolution',
                    'qa_pair',
                    'negative_example',
                    'correction'
                  )),

  -- Source references
  source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  source_ticket_id       INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  source_handoff_id      INTEGER REFERENCES conversation_handoffs(id) ON DELETE SET NULL,

  -- The actual learning content
  input_text      TEXT NOT NULL,     -- customer question / situation
  output_text     TEXT,              -- ideal response / resolution
  context_json    JSONB NOT NULL DEFAULT '{}',

  -- Quality signals
  quality_score   NUMERIC(3,2),
  labeled_by      VARCHAR(50) CHECK (labeled_by IN ('human','auto','feedback','ai')),
  human_approved  BOOLEAN,
  approved_by     INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  rejection_reason TEXT,

  -- Training lifecycle
  is_included_in_training BOOLEAN NOT NULL DEFAULT FALSE,
  training_batch  VARCHAR(100),
  trained_at      TIMESTAMPTZ,

  -- Deduplication
  content_hash    VARCHAR(64),      -- SHA-256 of input_text for dedup

  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add embedding for similarity search
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    ALTER TABLE learning_samples
      ADD COLUMN IF NOT EXISTS input_embedding VECTOR(1536);
  ELSE
    ALTER TABLE learning_samples
      ADD COLUMN IF NOT EXISTS input_embedding TEXT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_learning_project_type
  ON learning_samples(project_id, sample_type)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_learning_approved
  ON learning_samples(project_id, human_approved)
  WHERE human_approved = TRUE AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_learning_training
  ON learning_samples(is_included_in_training)
  WHERE is_included_in_training = FALSE AND human_approved = TRUE;

CREATE INDEX IF NOT EXISTS idx_learning_hash
  ON learning_samples(content_hash) WHERE content_hash IS NOT NULL;

-- ============================================================
-- SECTION 12: MESSAGE_MEDIA_ANALYSIS — OCR, Vision, Transcription
-- ============================================================

CREATE TABLE IF NOT EXISTS message_media_analysis (
  id              SERIAL PRIMARY KEY,
  message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id   INTEGER REFERENCES message_attachments(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  analysis_type   VARCHAR(50) NOT NULL
                  CHECK (analysis_type IN (
                    'ocr',
                    'vision_description',
                    'object_detection',
                    'face_detection',
                    'text_extraction',
                    'audio_transcription',
                    'video_transcription',
                    'pdf_extraction',
                    'sentiment',
                    'intent_classification',
                    'language_detection',
                    'translation',
                    'summary'
                  )),

  -- Model provenance
  model_name      VARCHAR(150) NOT NULL,
  model_provider  VARCHAR(50) NOT NULL,
  model_version   VARCHAR(50),

  -- Results
  result_text     TEXT,              -- primary text output (OCR text, transcript, description)
  result_json     JSONB NOT NULL DEFAULT '{}', -- structured output (bounding boxes, labels, etc.)
  result_language VARCHAR(20),
  confidence      NUMERIC(4,3),

  -- Cost tracking
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_usd        NUMERIC(10,6),
  latency_ms      INTEGER,

  -- State
  status          VARCHAR(50) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','done','failed','skipped')),
  error_message   TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add embedding for semantic search of analysis results
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    ALTER TABLE message_media_analysis
      ADD COLUMN IF NOT EXISTS result_embedding VECTOR(1536);
  ELSE
    ALTER TABLE message_media_analysis
      ADD COLUMN IF NOT EXISTS result_embedding TEXT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_media_analysis_message
  ON message_media_analysis(message_id);

CREATE INDEX IF NOT EXISTS idx_media_analysis_project_type
  ON message_media_analysis(project_id, analysis_type);

CREATE INDEX IF NOT EXISTS idx_media_analysis_pending
  ON message_media_analysis(status, created_at)
  WHERE status = 'pending';

-- ============================================================
-- SECTION 13: RETENTION_POLICIES — Archiving governance
-- ============================================================

CREATE TABLE IF NOT EXISTS retention_policies (
  id            SERIAL PRIMARY KEY,
  table_name    VARCHAR(100) NOT NULL UNIQUE,
  retain_days   INTEGER NOT NULL,
  action        VARCHAR(50) NOT NULL
                CHECK (action IN ('delete','archive','anonymize','compress')),
  filter_column VARCHAR(100) NOT NULL DEFAULT 'created_at',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at   TIMESTAMPTZ,
  rows_affected BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default retention policies
INSERT INTO retention_policies (table_name, retain_days, action) VALUES
  ('webhook_events',          90,    'delete'),
  ('ai_inference_logs',       365,   'archive'),
  ('ai_thinking_traces',      90,    'delete'),
  ('traces',                  180,   'archive'),
  ('domain_events',           730,   'archive'),
  ('admin_audit_logs',        2555,  'archive'),   -- 7 years legal
  ('messages',                1095,  'archive'),   -- 3 years
  ('learning_samples',        36500, 'archive')    -- indefinite (100 years)
ON CONFLICT (table_name) DO NOTHING;

-- ============================================================
-- SECTION 14: MESSAGE ATTACHMENTS — Fix for enterprise media
-- ============================================================

-- Fix file_size to BIGINT (support files > 2GB)
ALTER TABLE message_attachments
  ALTER COLUMN file_size TYPE BIGINT USING file_size::bigint;

ALTER TABLE message_attachments
  ADD COLUMN IF NOT EXISTS mime_type          VARCHAR(150),
  ADD COLUMN IF NOT EXISTS storage_provider   VARCHAR(50) NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS storage_bucket     VARCHAR(255),
  ADD COLUMN IF NOT EXISTS storage_key        TEXT,              -- S3/GCS object key
  ADD COLUMN IF NOT EXISTS cdn_url            TEXT,              -- CDN URL (fast)
  ADD COLUMN IF NOT EXISTS thumbnail_url      TEXT,
  ADD COLUMN IF NOT EXISTS thumbnail_key      TEXT,             -- thumbnail S3 key
  ADD COLUMN IF NOT EXISTS attachment_type    VARCHAR(50) NOT NULL DEFAULT 'file',
  ADD COLUMN IF NOT EXISTS duration_seconds   INTEGER,          -- for audio/video
  ADD COLUMN IF NOT EXISTS width              INTEGER,
  ADD COLUMN IF NOT EXISTS height             INTEGER,
  ADD COLUMN IF NOT EXISTS is_safe            BOOLEAN,
  ADD COLUMN IF NOT EXISTS scanned_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at         TIMESTAMPTZ,      -- for LINE CDN URLs
  ADD COLUMN IF NOT EXISTS permanent_url      TEXT,             -- permanent copy URL
  ADD COLUMN IF NOT EXISTS platform_url       TEXT;             -- original platform URL (may expire)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_type_check') THEN
    ALTER TABLE message_attachments
      ADD CONSTRAINT attachments_type_check
      CHECK (attachment_type IN (
        'image','audio','video','document','sticker',
        'location','contact','file','voice'
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_provider_check') THEN
    ALTER TABLE message_attachments
      ADD CONSTRAINT attachments_provider_check
      CHECK (storage_provider IN ('local','s3','gcs','azure_blob','cloudflare_r2','line_cdn','wa_cdn'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_attachments_message
  ON message_attachments(message_id);

CREATE INDEX IF NOT EXISTS idx_attachments_type
  ON message_attachments(attachment_type);

CREATE INDEX IF NOT EXISTS idx_attachments_pending_safe
  ON message_attachments(is_safe)
  WHERE is_safe IS NULL;  -- not yet scanned

-- ============================================================
-- SECTION 15: AI MEMORY — Fix missing embedding_model column
-- ============================================================

ALTER TABLE ai_memory
  ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(100) DEFAULT 'text-embedding-3-small',
  ADD COLUMN IF NOT EXISTS access_count    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_verified     BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================================
-- SECTION 16: CHANNEL CREDENTIALS — Encrypted columns
-- ============================================================
-- NOTE: Application MUST use AES-256-GCM before inserting encrypted columns
-- NEVER store raw secrets in these columns

ALTER TABLE project_channels
  ADD COLUMN IF NOT EXISTS channel_name             VARCHAR(255),
  ADD COLUMN IF NOT EXISTS webhook_url              TEXT,
  ADD COLUMN IF NOT EXISTS verify_token             VARCHAR(500),
  ADD COLUMN IF NOT EXISTS secret_token_encrypted   BYTEA,      -- AES-256-GCM ciphertext
  ADD COLUMN IF NOT EXISTS credentials_encrypted    BYTEA,      -- encrypted JSON blob
  ADD COLUMN IF NOT EXISTS encryption_key_id        VARCHAR(200), -- KMS key ID (never the key itself)
  ADD COLUMN IF NOT EXISTS encrypted_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_verified_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- NOTE: After adding these columns, migrate plaintext → encrypted at application layer
-- Then NULL OUT secret_token and credentials_json columns

-- ============================================================
-- SECTION 17: UPDATED_AT TRIGGERS (Extend to more tables)
-- ============================================================

-- Trigger function already created in 014, extend to new tables:

DROP TRIGGER IF EXISTS trg_domain_events_no_update ON domain_events;
-- domain_events is append-only — enforced by RULE, no trigger needed

DROP TRIGGER IF EXISTS trg_webhook_events_updated ON webhook_events;
CREATE TRIGGER trg_webhook_events_updated
  BEFORE UPDATE ON webhook_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_knowledge_docs_updated ON knowledge_documents;
CREATE TRIGGER trg_knowledge_docs_updated
  BEFORE UPDATE ON knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_learning_samples_updated ON learning_samples;
CREATE TRIGGER trg_learning_samples_updated
  BEFORE UPDATE ON learning_samples
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_media_analysis_updated ON message_media_analysis;
CREATE TRIGGER trg_media_analysis_updated
  BEFORE UPDATE ON message_media_analysis
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_project_prompts_updated ON project_prompts;
CREATE TRIGGER trg_project_prompts_updated
  BEFORE UPDATE ON project_prompts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- SECTION 18: CONVERSATION PARTICIPANTS — Fix type + group columns
-- ============================================================

ALTER TABLE conversation_participants
  ADD COLUMN IF NOT EXISTS group_role     VARCHAR(50) DEFAULT 'member'
                           CHECK (group_role IN ('owner','admin','member','observer','bot')),
  ADD COLUMN IF NOT EXISTS display_name  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS avatar_url    TEXT,
  ADD COLUMN IF NOT EXISTS line_member_type VARCHAR(20),  -- LINE group member type
  ADD COLUMN IF NOT EXISTS joined_via    VARCHAR(50) DEFAULT 'invite';  -- 'invite','join','webhook'

-- ============================================================
-- SECTION 19: MESSAGES — Fix messages content columns
-- ============================================================

-- Add original_content preservation (for recall feature)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS original_content TEXT,   -- preserved after recall/edit
  ADD COLUMN IF NOT EXISTS edited_content   TEXT;   -- previous content before edit

-- Add sender FK linkage
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sender_identity_id INTEGER REFERENCES identities(id) ON DELETE SET NULL;

-- ============================================================
-- SECTION 20: TICKETS — Fix SLA timestamps
-- ============================================================

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS sla_response_due_at   TIMESTAMPTZ,   -- calculated response deadline
  ADD COLUMN IF NOT EXISTS sla_resolve_due_at    TIMESTAMPTZ,   -- calculated resolve deadline
  ADD COLUMN IF NOT EXISTS sla_response_breached BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sla_resolve_breached  BOOLEAN NOT NULL DEFAULT FALSE;

-- Rename existing due_date to be more specific
-- Note: due_date = sla_resolve_due_at (same concept, explicit naming)
-- Keep due_date for backward compatibility, populate sla_resolve_due_at going forward

-- ============================================================
-- FINAL SUMMARY COMMENT
-- ============================================================
-- Migration 015 adds/fixes:
--   [NEW] uuid_generate_v7() function
--   [NEW] webhook_events (BLOCK-4 resolved)
--   [NEW] domain_events append-only (BLOCK-8 resolved)
--   [NEW] conversation_handoffs
--   [NEW] ai_inference_logs (observability)
--   [NEW] knowledge_documents + knowledge_embeddings (renamed)
--   [NEW] learning_samples (BLOCK-9 resolved)
--   [NEW] message_media_analysis (BLOCK-9 resolved)
--   [NEW] retention_policies
--   [FIXED] Soft delete on all major tables (BLOCK-7 resolved)
--   [FIXED] GDPR/PII columns on profiles + identities
--   [FIXED] companies: slug, status, plan_tier
--   [FIXED] projects: slug, status, not-null company_id
--   [FIXED] project_prompts: versioning + A/B support
--   [FIXED] message_attachments: storage_key, cdn_url, platform_url, mime_type
--   [FIXED] project_channels: encrypted credential columns
--   [FIXED] ai_memory: embedding_model, access tracking
--   [FIXED] conversation_participants: group columns
--   [FIXED] messages: original_content, sender_identity_id
--   [FIXED] tickets: SLA response/resolve breach columns
--   [ADDED] updated_at triggers on all new tables
-- ============================================================
