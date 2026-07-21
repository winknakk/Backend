-- ============================================================
-- TicketX / PromptX Platform — Messaging Context Schema
-- /database/latest/schema/02_messaging.sql
-- Target Database: PostgreSQL 16+
-- ============================================================

-- 1. CONVERSATIONS
CREATE TABLE IF NOT EXISTS conversations (
  id                      SERIAL PRIMARY KEY,
  identity_id             INTEGER REFERENCES identities(id) ON DELETE SET NULL,
  project_id              INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel                 VARCHAR(50) NOT NULL,
  conversation_type       VARCHAR(50) NOT NULL DEFAULT 'direct' CHECK (conversation_type IN ('direct','group','multi_party','internal')),
  status                  VARCHAR(50) NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','escalated','resolved','closed')),
  handled_by              VARCHAR(20) NOT NULL DEFAULT 'ai' CHECK (handled_by IN ('ai','human','bot','system')),
  operator_id             INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  assigned_pm             VARCHAR(255),
  promptx_conversation_id VARCHAR(100) UNIQUE,
  takeover_state          VARCHAR(50) NOT NULL DEFAULT 'none' CHECK (takeover_state IN ('none','requested','active','released')),
  takeover_operator_id    INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  takeover_expires_at     TIMESTAMPTZ,
  last_message_at         TIMESTAMPTZ,
  first_response_at       TIMESTAMPTZ,
  closed_at               TIMESTAMPTZ,
  metadata                JSONB NOT NULL DEFAULT '{}',
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at              TIMESTAMPTZ
);

COMMENT ON TABLE conversations IS 'Messaging Context Aggregate Root — tracks channel conversation threads';

CREATE INDEX idx_conv_project_status ON conversations(project_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_conv_project_status_last ON conversations(project_id, status, last_message_at DESC NULLS LAST) WHERE deleted_at IS NULL;
CREATE INDEX idx_conv_operator ON conversations(operator_id) WHERE operator_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_conv_takeover_active ON conversations(takeover_state) WHERE takeover_state = 'active';

-- 2. MESSAGES
CREATE TABLE IF NOT EXISTS messages (
  id                     SERIAL PRIMARY KEY,
  conversation_id        INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id             INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id              INTEGER, -- scalar reference to Support Context (no FK cascade)
  role                   VARCHAR(50) NOT NULL CHECK (role IN ('customer','ai','human_operator','system','bot','internal')),
  sender_type            VARCHAR(20) NOT NULL DEFAULT 'unknown' CHECK (sender_type IN ('customer','operator','ai','system','unknown')),
  sender_id              VARCHAR(255),
  operator_id            INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  message_type           VARCHAR(50) NOT NULL DEFAULT 'text' CHECK (message_type IN ('text','image','audio','video','file','sticker','location','template','carousel','quick_reply','internal_note','system_event','ai_thinking')),
  message_purpose        VARCHAR(50) NOT NULL DEFAULT 'reply' CHECK (message_purpose IN ('reply','internal_note','system_event','ai_reasoning','escalation_note','proactive')),
  content                TEXT,
  content_json           JSONB NOT NULL DEFAULT '{}',
  external_id            VARCHAR(255),
  is_recalled            BOOLEAN NOT NULL DEFAULT FALSE,
  recalled_at            TIMESTAMPTZ,
  original_content       TEXT,
  edited_at              TIMESTAMPTZ,
  edited_content         TEXT,
  is_visible_to_customer BOOLEAN NOT NULL DEFAULT TRUE,
  is_visible_to_operator BOOLEAN NOT NULL DEFAULT TRUE,
  ai_model               VARCHAR(100),
  ai_confidence          NUMERIC(4,3),
  processing_ms          INTEGER,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at             TIMESTAMPTZ,
  UNIQUE (conversation_id, external_id)
);

COMMENT ON TABLE messages IS 'Individual messages within a conversation thread';

CREATE INDEX idx_messages_conv_created ON messages(conversation_id, created_at ASC) WHERE deleted_at IS NULL;
CREATE INDEX idx_messages_ticket ON messages(ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX idx_messages_purpose ON messages(conversation_id, message_purpose);

-- 3. MESSAGE ATTACHMENTS
CREATE TABLE IF NOT EXISTS message_attachments (
  id                SERIAL PRIMARY KEY,
  message_id        INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_name         VARCHAR(500) NOT NULL,
  file_url          VARCHAR(2048) NOT NULL,
  file_type         VARCHAR(100),
  file_size         BIGINT,
  mime_type         VARCHAR(150),
  storage_provider  VARCHAR(50) NOT NULL DEFAULT 'local' CHECK (storage_provider IN ('local','s3','gcs','azure_blob','cloudflare_r2','line_cdn','wa_cdn')),
  storage_key       TEXT,
  platform_url      TEXT,
  permanent_url     TEXT,
  thumbnail_url     TEXT,
  attachment_type   VARCHAR(50) NOT NULL DEFAULT 'file' CHECK (attachment_type IN ('image','audio','video','document','sticker','location','file','voice')),
  duration_seconds  INTEGER,
  width             INTEGER,
  height            INTEGER,
  is_safe           BOOLEAN,
  scanned_at        TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE message_attachments IS 'Media files attached to messages';

CREATE INDEX idx_attachments_message ON message_attachments(message_id);
CREATE INDEX idx_attachments_type ON message_attachments(attachment_type);
