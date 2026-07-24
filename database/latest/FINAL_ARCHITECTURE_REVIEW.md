# FINAL ENTERPRISE ARCHITECTURE REVIEW
## TicketX / PromptX Platform — Pre-Production Database Freeze

```
Classification : FINAL REVIEW — DO NOT DEPLOY UNTIL RESOLVED
Date           : 2026-07-21
Reviewer       : Principal Enterprise Architect / AI Platform Architect
Database       : PostgreSQL (production target)
Migrations     : 001–014 inclusive
Review Type    : BRUTAL — Backward compatibility NOT considered
                 Goal: Freeze schema before production
```

---

## EXECUTIVE SUMMARY

This is not a syntax review. This is a architecture challenge.

The current schema was **evolved from a NoCoDB prototype** through 14 migrations. It shows signs of organic growth without a coherent enterprise design up front.

Before this schema touches production PostgreSQL, several decisions must be made and locked in permanently — because changing them later will require table rewrites, data migrations under live traffic, and likely downtime.

**The schema is 60% ready for a startup MVP. It is 30% ready for an enterprise AI platform.**

---

## SCORES

```
Production Readiness Score : 4.5 / 10
Architecture Score         : 5.0 / 10
Scalability Score          : 4.0 / 10
Enterprise Score           : 3.5 / 10

VERDICT: NOT READY FOR PRODUCTION
Estimated remediation effort: 3–5 engineering days
```

---

## SCORE BREAKDOWN

| Dimension | Score | Key Reason |
|-----------|-------|-----------|
| Primary Key Strategy | 3/10 | SERIAL everywhere — not distributed-safe |
| Data Type Integrity | 4/10 | identities.id VARCHAR vs INTEGER conflict unfixed |
| Multi-tenant Isolation | 6/10 | project_id present but nullable in wrong places |
| Event Sourcing | 3/10 | outbox exists but no webhook payload store |
| Media Architecture | 3/10 | Attachment table exists but no OCR/Vision result storage |
| AI Memory | 2/10 | No long-term learning structure |
| Security | 3/10 | Plaintext secrets, no PII flagging, no GDPR columns |
| Observability | 4/10 | traces exist, no cost/token/latency analytics table |
| Idempotency | 5/10 | external_id on messages, but webhook layer not covered |
| SLA Chain | 4/10 | SLA columns added but no business-hour-aware calculation metadata |
| RBAC | 3/10 | operators table added but no granular permissions |
| Soft Delete | 0/10 | No soft delete on any table |
| Retention Policy | 0/10 | No archiving or TTL on any table |
| Audit Log | 4/10 | admin_audit_logs exists but not applied to all tables |

---

## PART 1: BRUTAL TABLE-BY-TABLE REVIEW

---

### 1.1 PRIMARY KEY STRATEGY — REJECT SERIAL, USE UUID

**Current state:** Every table uses `SERIAL` (auto-increment INTEGER).

**Why this is a problem for an AI platform:**

```
SERIAL PRIMARY KEY problems:
  1. Leaks business information — ticket ID 42 means you have 42 tickets
  2. Not distributed-safe — can't shard or replicate writes easily
  3. Range attacks — attacker can enumerate /api/tickets/1, /2, /3...
  4. Cannot merge data from multiple environments (staging → prod) safely
  5. BullMQ job IDs, PromptX conversation IDs, LINE message IDs are all
     external UUIDs — FK references become type-unsafe

RECOMMENDATION:
  Use UUID v7 (time-ordered) for all PRIMARY KEYS
  - UUID v7 is both globally unique AND naturally ordered by creation time
  - PostgreSQL 17+ has gen_ulid(), or use pgcrypto + custom function
  - All BullMQ, PromptX, LINE IDs are already string/UUID — FK alignment
```

**Impact of NOT changing now:** After production with millions of rows, changing PK type requires full table rebuild. Estimated cost: 4-8 hours downtime per large table.

**Recommended action BEFORE production:**
```sql
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- for ILIKE search

-- UUID v7 generator (time-ordered, sortable)
CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS UUID AS $$
BEGIN
  RETURN encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid()) placing
          substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
          from 1 for 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
END $$ LANGUAGE plpgsql VOLATILE;
```

---

### 1.2 identities TABLE — THE ROOT PROBLEM

The `identities` table is the **center of the entire customer-facing data model** — and it has the most severe type conflict in the entire schema.

**The conflict:**
- `001_initial_schema.sql`: `id SERIAL PRIMARY KEY` (INTEGER)
- `nocodb_to_postgresql.sql`: `id VARCHAR(50) PRIMARY KEY` (STRING)
- `007_webchat_support.sql`: `identity_id VARCHAR(255) REFERENCES identities(id)`
- `001_initial_schema.sql` conversations: `identity_id INTEGER REFERENCES identities(id)`

**This is a split-brain identity problem.** Two different type systems co-exist. In a fresh migration run, one will fail.

**The deeper problem:** `identities` is actually a poor model for what it represents.

A LINE user (Uxxx), a WhatsApp user (+66xxx), and the same physical person's email are three separate identities — but they should all merge into one `profile`. The current model does this, but only half-correctly.

**What's missing:**
- A LINE group has a `C` channel_ref (not `U`) — it's a group, not a person. The current schema treats group channels the same as individual channels.
- An identity can change its LINE display name — there's no `display_name_history`.
- LINE push tokens expire — no `token_expires_at` column.

**Final recommended schema:**
```sql
CREATE TABLE identities (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  profile_id      INTEGER REFERENCES profiles(id) ON DELETE SET NULL,

  -- Channel identification
  channel         VARCHAR(50) NOT NULL
                  CHECK (channel IN (
                    'line','line_group','line_room',
                    'whatsapp','whatsapp_business',
                    'email','webchat',
                    'facebook','instagram','telegram',
                    'internal'
                  )),
  channel_ref     VARCHAR(500) NOT NULL,    -- LINE userId (U...) or groupId (C...)
  channel_name    VARCHAR(255),             -- Display name from channel
  avatar_url      TEXT,
  is_group        BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE for line_group/room

  -- Token management
  push_token      TEXT,                     -- LINE push token (encrypted)
  token_expires_at TIMESTAMPTZ,

  -- PII and GDPR
  is_pii          BOOLEAN NOT NULL DEFAULT TRUE,
  gdpr_erased_at  TIMESTAMPTZ,             -- GDPR erasure timestamp

  metadata        JSONB NOT NULL DEFAULT '{}',
  verified_at     TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,             -- Soft delete
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (channel, channel_ref)
);

CREATE INDEX idx_identities_profile    ON identities(profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX idx_identities_channel    ON identities(channel, channel_ref);
CREATE INDEX idx_identities_is_group   ON identities(is_group) WHERE is_group = TRUE;
```

---

### 1.3 conversations TABLE — INSUFFICIENT FOR AI PLATFORM

**Current problems after migration 014:**

The `conversations` table still stores `takeover_state` as a column inline. This is wrong for an AI platform because:

1. **Takeover is a temporal state** — it has a full lifecycle: requested → active → released/expired → re-acquired. A single VARCHAR column cannot represent this lifecycle with timestamps and operators.
2. **Multiple handoffs happen** — AI → Human → AI → Human is a sequence of events, not a single state.
3. **The conversation table is overloaded** — it stores both conversation metadata AND current operational state.

**Split recommendation:**
```
conversations           → immutable conversation record (who, what channel, project)
conversation_state      → mutable current state (status, handled_by, operator, last_message)
conversation_handoffs   → history of every AI↔Human transition
```

**Why this matters:** PromptX needs to query "is this conversation currently under human control?" This should be a fast, indexed lookup — not a join through a JSONB field.

**Revised schema:**
```sql
CREATE TABLE conversations (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id              INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  identity_id             UUID REFERENCES identities(id) ON DELETE SET NULL,
  channel                 VARCHAR(50) NOT NULL,
  conversation_type       VARCHAR(50) NOT NULL DEFAULT 'direct'
                          CHECK (conversation_type IN ('direct','group','multi_party','issue_session','internal')),
  external_conversation_id VARCHAR(500) UNIQUE,  -- LINE groupId, WA thread ID
  promptx_conversation_id VARCHAR(255) UNIQUE,
  subject                 VARCHAR(500),          -- auto-generated summary subject
  status                  VARCHAR(50) NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','pending','escalated','resolved','closed','archived')),

  -- Current ownership (denormalized for speed — updated by trigger)
  current_owner           VARCHAR(20) NOT NULL DEFAULT 'ai'
                          CHECK (current_owner IN ('ai','human','system','closed')),
  current_operator_id     INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  last_message_at         TIMESTAMPTZ,
  message_count           INTEGER NOT NULL DEFAULT 0,

  -- Lifecycle
  first_response_at       TIMESTAMPTZ,
  resolved_at             TIMESTAMPTZ,
  closed_at               TIMESTAMPTZ,

  -- Soft delete and archiving
  deleted_at              TIMESTAMPTZ,
  archived_at             TIMESTAMPTZ,

  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Conversation handoff history (replaces takeover_state inline column)
CREATE TABLE conversation_handoffs (
  id              SERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_owner      VARCHAR(20) NOT NULL,          -- 'ai','human'
  to_owner        VARCHAR(20) NOT NULL,
  from_operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  to_operator_id  INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  reason          VARCHAR(255),
  triggered_by    VARCHAR(50),                   -- 'customer_request','ai_escalation','operator_claim','timeout'
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,
  duration_seconds INTEGER GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (ended_at - started_at))::INTEGER
  ) STORED
);

CREATE INDEX idx_conv_project_status ON conversations(project_id, status, last_message_at DESC NULLS LAST);
CREATE INDEX idx_conv_identity       ON conversations(identity_id) WHERE identity_id IS NOT NULL;
CREATE INDEX idx_conv_current_owner  ON conversations(current_owner, project_id) WHERE current_owner = 'human';
CREATE INDEX idx_conv_not_deleted    ON conversations(project_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_handoffs_conv       ON conversation_handoffs(conversation_id, started_at DESC);
```

---

### 1.4 messages TABLE — CRITICAL ARCHITECTURE FLAW DISCOVERED IN DATA

**Discovery from actual seed data:**

The AI was storing the **entire formatted conversation history as a single JSON string** in each message's `content` field, like this:

```
message[5].content = '{"formatted":"Customer: ...\nAssistant: {...}\nCustomer:...","count":5}'
```

This means the AI re-serialized the entire conversation on every message. This is:
- **O(n²) storage growth** — each new message stores all previous messages again
- **Not queryable** — you can't filter by content
- **Not suitable for semantic search** — embedding this is meaningless
- **Not suitable for AI learning** — the "data" is garbage

**This is the most dangerous data quality issue in the entire schema.** Historical messages in the database are currently AI-formatted strings, not actual customer/AI message pairs.

**Required fix before production:**

The messages table must enforce clean separation:

```sql
CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id),  -- denormalized for partition/query speed

  -- Who sent this message
  role            VARCHAR(20) NOT NULL
                  CHECK (role IN ('customer','ai','human_operator','system','bot','internal')),
  sender_type     VARCHAR(20) NOT NULL DEFAULT 'unknown',
  sender_identity_id UUID REFERENCES identities(id) ON DELETE SET NULL,   -- for customer
  sender_operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,  -- for operator

  -- Content — strictly typed
  message_type    VARCHAR(50) NOT NULL DEFAULT 'text'
                  CHECK (message_type IN (
                    'text','image','audio','video','file','sticker',
                    'location','template','carousel','quick_reply',
                    'internal_note','system_event',
                    'ai_thinking','tool_call','tool_result'
                  )),
  content         TEXT,                          -- Clean text ONLY. Never JSON. Never history.
  content_json    JSONB NOT NULL DEFAULT '{}',  -- Structured rich message (carousel, template)

  -- For AI messages: link to the reasoning that produced this
  ai_trace_id     UUID REFERENCES ai_thinking_traces(id) ON DELETE SET NULL,

  -- Channel message deduplication
  external_id     VARCHAR(500),                  -- LINE messageId, WA messageId
  channel_metadata JSONB NOT NULL DEFAULT '{}', -- raw channel-specific metadata

  -- Message lifecycle
  is_recalled     BOOLEAN NOT NULL DEFAULT FALSE,
  recalled_at     TIMESTAMPTZ,
  original_content TEXT,                         -- preserved content after recall
  edited_at       TIMESTAMPTZ,
  edited_content  TEXT,                          -- original before edit

  -- Visibility control
  is_visible_to_customer BOOLEAN NOT NULL DEFAULT TRUE,
  is_visible_to_operator BOOLEAN NOT NULL DEFAULT TRUE,

  -- AI metadata (only populated for role='ai')
  ai_model        VARCHAR(100),
  ai_confidence   NUMERIC(4,3),
  processing_ms   INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,

  -- Soft delete
  deleted_at      TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT unique_channel_message UNIQUE (conversation_id, external_id)
);

-- Partition suggestion (future, when messages > 10M rows):
-- PARTITION BY RANGE (created_at) -- monthly partitions

CREATE INDEX idx_messages_conv_time  ON messages(conversation_id, created_at ASC) WHERE deleted_at IS NULL;
CREATE INDEX idx_messages_role       ON messages(conversation_id, role);
CREATE INDEX idx_messages_project    ON messages(project_id, created_at DESC);
CREATE INDEX idx_messages_external   ON messages(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_messages_recalled   ON messages(is_recalled) WHERE is_recalled = TRUE;
```

---

### 1.5 document_embeddings — WRONG DESIGN FOR MULTI-TENANT RAG

**Current problem:** `document_embeddings` has `doc_id VARCHAR(255) UNIQUE` — this is a **global** uniqueness constraint. In a multi-tenant system, two different projects can have documents with the same doc_id (e.g. "faq-001").

**After migration 014** we add `project_id` but the existing `UNIQUE(doc_id)` constraint still enforces global uniqueness.

**Correct design:**
```sql
CREATE TABLE knowledge_documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Document identity
  external_doc_id VARCHAR(255),                  -- client-provided stable ID
  title           VARCHAR(500) NOT NULL,
  source_url      TEXT,
  document_type   VARCHAR(50) NOT NULL DEFAULT 'knowledge'
                  CHECK (document_type IN (
                    'faq','manual','policy','procedure',
                    'ticket_resolution','conversation_summary',
                    'product_spec','legal','other'
                  )),
  language        VARCHAR(20) NOT NULL DEFAULT 'th',

  -- Content
  raw_content     TEXT NOT NULL,                 -- original text
  processed_content TEXT,                        -- cleaned/normalized

  -- Chunking metadata
  chunk_index     INTEGER NOT NULL DEFAULT 0,
  chunk_total     INTEGER NOT NULL DEFAULT 1,
  parent_doc_id   UUID REFERENCES knowledge_documents(id) ON DELETE CASCADE,  -- for chunks

  -- Versioning
  version         INTEGER NOT NULL DEFAULT 1,
  superseded_by   UUID REFERENCES knowledge_documents(id) ON DELETE SET NULL,

  -- State
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  indexed_at      TIMESTAMPTZ,                   -- when embedding was computed
  deleted_at      TIMESTAMPTZ,

  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (project_id, external_doc_id, chunk_index)
);

-- Separate embeddings table (allows re-embedding without data loss)
CREATE TABLE knowledge_embeddings (
  id              SERIAL PRIMARY KEY,
  document_id     UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  model_name      VARCHAR(100) NOT NULL DEFAULT 'text-embedding-3-small',
  model_version   VARCHAR(50),
  embedding       VECTOR(1536) NOT NULL,
  dimensions      INTEGER NOT NULL DEFAULT 1536,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_knowledge_project_active  ON knowledge_documents(project_id, is_active) WHERE is_active = TRUE AND deleted_at IS NULL;
CREATE INDEX idx_knowledge_type            ON knowledge_documents(project_id, document_type);
CREATE INDEX idx_embeddings_project_vector ON knowledge_embeddings(project_id);
CREATE INDEX idx_embeddings_ivfflat        ON knowledge_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 200);

-- Reasoning: Separating documents from embeddings allows:
-- 1. Re-embedding with a new model without touching document content
-- 2. Storing multiple embeddings per doc (different models)
-- 3. Versioning embeddings independently
```

---

### 1.6 WEBHOOK PAYLOAD STORE — COMPLETELY MISSING

**This is one of the most important missing components for an AI platform.**

LINE and WhatsApp send webhook payloads. Currently there is no table that stores the raw webhook payload.

**Why this matters:**

| Scenario | Impact Without Webhook Store |
|----------|------------------------------|
| LINE retries webhook | Duplicate message — no way to deduplicate at DB level |
| Webhook processing fails | No way to replay |
| AI learns from conversations | Raw LINE structured messages lost forever |
| Compliance audit | Cannot prove what payload was received |
| GPT Vision analysis later | Original image URL from LINE payload is gone |
| Debugging production issues | No replay capability |

**Required table:**
```sql
CREATE TABLE webhook_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,

  -- Source identification
  platform        VARCHAR(50) NOT NULL
                  CHECK (platform IN ('line','whatsapp','facebook','instagram','email','webchat','internal')),
  channel_type    VARCHAR(50),
  channel_id      VARCHAR(255),               -- LINE channel ID

  -- Deduplication
  platform_event_id VARCHAR(500),             -- LINE messageId, WA messageId
  idempotency_key   VARCHAR(500) UNIQUE,      -- hash(platform + platform_event_id)

  -- Payload
  raw_payload     JSONB NOT NULL,             -- FULL original webhook payload
  headers         JSONB NOT NULL DEFAULT '{}', -- HTTP headers (HMAC, content-type)
  signature       TEXT,                       -- HMAC signature for verification

  -- Processing state
  status          VARCHAR(50) NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received','processing','processed','failed','duplicate','replayed')),
  processed_at    TIMESTAMPTZ,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_retry_at   TIMESTAMPTZ,

  -- Traceability
  resulting_message_id UUID,                  -- FK set after message created
  bullmq_job_id   VARCHAR(255),

  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_webhook_idempotency ON webhook_events(idempotency_key);
CREATE INDEX idx_webhook_status_retry       ON webhook_events(status, next_retry_at)
  WHERE status IN ('received','failed');
CREATE INDEX idx_webhook_platform_event     ON webhook_events(platform, platform_event_id)
  WHERE platform_event_id IS NOT NULL;
CREATE INDEX idx_webhook_project_received   ON webhook_events(project_id, received_at DESC)
  WHERE project_id IS NOT NULL;
```

---

### 1.7 AI LEARNING — WHAT SHOULD BE STORED

**Yes — AI should learn from ALL of the following:**

| Source | Store What | Table |
|--------|-----------|-------|
| Text conversations | Full messages + resolution | `learning_samples` |
| Image messages | URL + OCR result + Vision result | `message_media_analysis` |
| PDF documents | Extracted text + embeddings | `knowledge_documents` |
| Audio messages | Transcript (Whisper) | `message_media_analysis` |
| Human takeover conversations | Full thread + resolution action | `learning_samples` |
| Ticket resolutions | Subject → resolution mapping | `learning_samples` |

**Required tables for AI learning pipeline:**

```sql
-- AI Learning Samples — curated from conversations/tickets
CREATE TABLE learning_samples (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sample_type     VARCHAR(50) NOT NULL
                  CHECK (sample_type IN (
                    'conversation_resolution',
                    'human_takeover_thread',
                    'ticket_resolution',
                    'qa_pair',
                    'negative_example'
                  )),

  -- Source reference
  source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  source_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  source_message_ids UUID[] DEFAULT '{}',     -- specific messages in the sample

  -- Content
  input_text      TEXT NOT NULL,              -- customer input / question
  output_text     TEXT,                       -- ideal response / resolution
  context_json    JSONB NOT NULL DEFAULT '{}', -- additional context

  -- Quality signals
  quality_score   NUMERIC(3,2),               -- 0.00 - 1.00
  labeled_by      VARCHAR(50),               -- 'human','auto','feedback'
  human_approved  BOOLEAN,
  approved_by     INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,

  -- Training state
  is_included_in_training BOOLEAN NOT NULL DEFAULT FALSE,
  training_batch  VARCHAR(100),
  trained_at      TIMESTAMPTZ,

  -- Embedding (for dedup and similarity search)
  input_embedding VECTOR(1536),

  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Media Analysis Results (OCR, Vision, Transcription)
CREATE TABLE message_media_analysis (
  id              SERIAL PRIMARY KEY,
  message_id      UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id   INTEGER REFERENCES message_attachments(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- What kind of analysis
  analysis_type   VARCHAR(50) NOT NULL
                  CHECK (analysis_type IN (
                    'ocr','vision_description','object_detection',
                    'audio_transcription','pdf_extraction',
                    'sentiment','classification','translation'
                  )),

  -- Model used
  model_name      VARCHAR(100) NOT NULL,       -- 'gpt-4o','gemini-1.5-pro','whisper-1'
  model_version   VARCHAR(50),
  provider        VARCHAR(50),                 -- 'openai','google','azure'

  -- Results
  result_text     TEXT,                        -- OCR text, transcription, description
  result_json     JSONB NOT NULL DEFAULT '{}', -- structured detection results
  confidence      NUMERIC(4,3),

  -- Embedding of the result (for semantic search)
  result_embedding VECTOR(1536),

  -- Cost tracking
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_usd        NUMERIC(10,6),
  latency_ms      INTEGER,

  -- State
  status          VARCHAR(50) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','done','failed')),
  error_message   TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_learning_project   ON learning_samples(project_id, sample_type) WHERE deleted_at IS NULL;
CREATE INDEX idx_learning_approved  ON learning_samples(project_id, human_approved) WHERE human_approved = TRUE;
CREATE INDEX idx_media_analysis_msg ON message_media_analysis(message_id);
CREATE INDEX idx_media_analysis_type ON message_media_analysis(project_id, analysis_type);
```

---

### 1.8 OBSERVABILITY TABLES — CURRENTLY INSUFFICIENT

The current `traces` table is a basic tool execution log. It does NOT support:
- Cost tracking per project (billing)
- Token usage trends (analytics dashboard)
- Prompt version tracking (A/B testing)
- Embedding model version tracking
- Knowledge base version at time of answer

**Required table:**
```sql
CREATE TABLE ai_inference_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,
  trace_id        UUID REFERENCES ai_thinking_traces(id) ON DELETE SET NULL,

  -- What was called
  operation_type  VARCHAR(50) NOT NULL
                  CHECK (operation_type IN (
                    'chat_completion','embedding','vision','transcription',
                    'ocr','tool_call','rag_search','reranking'
                  )),
  model_name      VARCHAR(100) NOT NULL,
  model_provider  VARCHAR(50) NOT NULL,       -- 'openai','google','azure','anthropic'
  model_version   VARCHAR(50),

  -- Prompt versioning
  prompt_template_id INTEGER,                  -- FK to project_prompts if relevant
  prompt_version     INTEGER,
  knowledge_version  VARCHAR(50),             -- e.g. hash of knowledge base at time of call
  embedding_model    VARCHAR(100),

  -- Performance
  latency_ms      INTEGER NOT NULL,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  total_tokens    INTEGER GENERATED ALWAYS AS (COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) STORED,

  -- Cost
  cost_usd        NUMERIC(10,6),

  -- Quality
  confidence_score NUMERIC(4,3),
  guardrail_result VARCHAR(20),

  -- Workflow context
  workflow_run_id VARCHAR(255),
  step_name       VARCHAR(100),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()

  -- NOTE: Partition this table by created_at monthly when volume > 1M/month
);

CREATE INDEX idx_ai_logs_project_time    ON ai_inference_logs(project_id, created_at DESC);
CREATE INDEX idx_ai_logs_model           ON ai_inference_logs(model_name, created_at DESC);
CREATE INDEX idx_ai_logs_operation       ON ai_inference_logs(project_id, operation_type);
```

---

### 1.9 JSONB USAGE REVIEW — CHALLENGE EVERY FIELD

**Rule:** JSONB is acceptable for truly dynamic, schema-less data. It is a crutch when used for things that have known structure.

| Column | Current Use | Verdict | Fix |
|--------|------------|---------|-----|
| `project_channels.credentials_json` | Stores LINE/WA tokens | ❌ BAD | Move to typed encrypted columns |
| `traces.arguments` / `traces.result` | Tool call args/result | ✅ OK | JSONB is correct here |
| `outbox_events.payload` | Event data | ✅ OK | Acceptable, add aggregate_type FK |
| `ticket_events.payload` | Event data | ✅ OK | Acceptable |
| `project_routing_rules.conditions` | Routing logic | ⚠️ RISKY | May need typed columns when rules grow |
| `conversations.metadata` | Ad-hoc data | ⚠️ RISKY | Should have schema after v1 |
| `operators.settings` | Operator preferences | ⚠️ RISKY | Fine for MVP, watch growth |
| `ai_thinking_traces.reasoning_steps` | Agent thought steps | ✅ OK | Inherently schema-less |
| `ai_thinking_traces.tool_calls` | Tool call log | ✅ OK | JSONB correct |
| `webhook_events.raw_payload` | Full webhook payload | ✅ REQUIRED | Must be JSONB |
| `webhook_events.headers` | HTTP headers | ✅ OK | |

**Most dangerous JSONB usage:**

`project_channels.credentials_json` currently stores:
```json
{ "channel_secret": "abc123", "channel_access_token": "eyJhb..." }
```

This is **plaintext credentials in JSON in a database**. If the database is dumped (pg_dump for backup, read replica, dev copy), all credentials are exposed. This must be encrypted **before any backup** reaches production.

---

## PART 2: FEATURE SUPPORT REVIEW

---

### 2.1 MULTI-COMPANY / MULTI-PROJECT / MULTI-CHANNEL

| Feature | Supported | Issue |
|---------|-----------|-------|
| Multi-Company | ✅ Yes | companies table exists |
| Multi-Project per Company | ✅ Yes | projects.company_id FK |
| Multi-Channel per Project | ✅ Yes | project_channels table |
| LINE (direct) | ✅ Yes | channel='line' |
| LINE Group | ⚠️ Partial | identities.channel='line_group' but no group membership tracking |
| LINE Room | ❌ No | Not modeled |
| Webchat | ⚠️ Partial | webchat_sessions exists, type FK broken |
| WhatsApp | ⚠️ Partial | channel type included but no WA-specific columns |
| WhatsApp Business API | ❌ No | Business account structure not modeled |
| Facebook | ❌ No | Not modeled (easy to add with generic channel design) |
| Instagram | ❌ No | Not modeled |
| Email | ⚠️ Partial | channel='email' exists, no email threading model |

**Missing: Channel-specific configuration tables**

Each channel type has unique configuration needs:
- LINE: channel_id, channel_secret, access_token, webhook_url
- WhatsApp: phone_number_id, business_account_id, access_token
- Email: SMTP host, from_address, IMAP settings
- Webchat: allowed_domains, widget_config

These all live in `credentials_json` JSONB — untyped and unqueryable. This will cause issues when building channel management UI.

---

### 2.2 LINE GROUP SCENARIO — FULL ANALYSIS

**Scenario:**
> Customer A starts talking. Customer B joins. Customer C uploads image. Bot answers. Admin takes over. Admin releases. AI resumes.

**Current schema support:**

```
Step 1: Customer A sends message
  → identities (channel='line_group', channel_ref='C...')
  → conversations (conversation_type='group')
  ✅ Works

Step 2: Customer B joins
  → conversation_participants entry for B
  ⚠️ conversation_participants.identity_id is VARCHAR — type inconsistency
  ⚠️ No JOIN event recorded in conversation_events

Step 3: Customer C uploads image
  → messages (message_type='image')
  → message_attachments (file_url = LINE CDN URL)
  ❌ LINE image URLs expire after 30 days — no re-download mechanism
  ❌ No storage_key for S3/GCS permanent copy
  ❌ No OCR/Vision result stored

Step 4: Bot answers
  → messages (role='ai')
  ✅ Works

Step 5: Admin takes over
  → conversations.takeover_state = 'active'
  → takeover_sessions row
  ✅ Partially works
  ⚠️ conversation_handoffs NOT created (history lost)

Step 6: Admin releases
  → takeover_state = 'none'
  ⚠️ No handoff record (AI re-seed context lost)

Step 7: AI resumes
  → AgentRuntime reads messages
  ❌ Cannot distinguish which messages were during human takeover
  ❌ Cannot identify which messages were from each participant (B vs C)
```

**Missing columns and tables for full GROUP support:**

```sql
-- 1. Add participant-level sender tracking to messages
-- messages.sender_identity_id already proposed above — needed here

-- 2. conversation_participants needs group-specific columns
ALTER TABLE conversation_participants
  ADD COLUMN IF NOT EXISTS group_role VARCHAR(50) DEFAULT 'member'
    CHECK (group_role IN ('owner','admin','member','observer','bot')),
  ADD COLUMN IF NOT EXISTS line_member_type VARCHAR(20),  -- 'sender','groupAdmin','member'
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- 3. Group session tracking
CREATE TABLE IF NOT EXISTS group_sessions (
  id              SERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_name    VARCHAR(255),
  issue_type      VARCHAR(100),              -- 'support_ticket','planning','review'
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,
  summary         TEXT,
  summary_embedding VECTOR(1536)
);
```

---

### 2.3 PROMPTX AGENT RUNTIME — CAN IT OPERATE FROM POSTGRESQL?

**What PromptX needs at runtime:**

| Need | Table | Status |
|------|-------|--------|
| Project system prompt | `project_prompts` | ✅ |
| Conversation history | `messages` | ⚠️ Corrupted data (JSON nesting) |
| AI settings (temp, model) | `project_ai_settings` | ✅ |
| SLA policy | `project_sla_policies` | ✅ |
| Routing rules | `project_routing_rules` | ✅ |
| MCP tool permissions | `project_mcp_permissions` | ✅ |
| Feature flags | `project_feature_flags` | ✅ |
| RAG documents | `knowledge_documents` + `knowledge_embeddings` | ⚠️ Rename/restructure needed |
| Current conversation state | `conversations` | ⚠️ takeover state mixed in |
| Agent memory (long-term) | `ai_memory` | ⚠️ Added in 014, no embedding model column |
| Tool call history | `traces` | ✅ |
| Webhook deduplication | `messages.external_id` | ✅ (partial — webhook layer missing) |

**Missing runtime state:**

```sql
-- PromptX needs to know: "What prompt version am I running on this project?"
ALTER TABLE project_prompts
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS ab_weight NUMERIC(4,2) DEFAULT 100.00,  -- A/B split
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

-- Multiple active prompts possible (A/B testing)
-- Remove UNIQUE constraint on project_id from project_prompts
-- Instead: only one active per project (enforced at app layer or partial unique index)
CREATE UNIQUE INDEX idx_project_prompts_active
  ON project_prompts(project_id) WHERE is_active = TRUE;
```

---

## PART 3: SECURITY REVIEW

---

### 3.1 PII AND GDPR

**Current state:** No PII tracking. No GDPR erasure mechanism. No data classification.

**Required columns (per GDPR Article 17 — Right to Erasure):**

```sql
-- Add to profiles:
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS gdpr_consent_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gdpr_erased_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS data_region       VARCHAR(20) DEFAULT 'TH',  -- data residency
  ADD COLUMN IF NOT EXISTS is_pii_erased     BOOLEAN NOT NULL DEFAULT FALSE;

-- GDPR erasure procedure:
-- When gdpr_erased_at set:
--   profiles.name = '[ERASED]'
--   profiles.email = null
--   identities.channel_ref = '[ERASED_' + hash + ']'
--   messages.content = '[ERASED]' (for messages from this user)
--   message_attachments: delete files from S3, set file_url = '[ERASED]'
```

### 3.2 ENCRYPTION

**Current state:** `project_channels.secret_token` and `credentials_json` are plaintext.

**Required strategy:**
```
Application-level encryption: AES-256-GCM
Key management: AWS KMS / Google Cloud KMS / HashiCorp Vault
Key rotation: Every 90 days (stored key_id in DB, not the key itself)

Required columns on project_channels:
  secret_token_encrypted  BYTEA       -- AES-256-GCM ciphertext
  credentials_encrypted   BYTEA       -- encrypted JSON blob
  encryption_key_id       VARCHAR(100) -- KMS key reference (NOT the key)
  encrypted_at            TIMESTAMPTZ

NEVER store:
  - Raw secret tokens
  - Raw access tokens
  - API keys in plaintext
  - Private keys
```

### 3.3 RBAC MODEL

**Current operators table has a flat role system:**
```
super_admin / admin / manager / agent / readonly
```

**This is insufficient for enterprise.** A Manager of Project A should not see Project B's conversations.

**The correct model is:**

```
Company Level:
  super_admin      → full company access
  admin            → company management, no data access

Project Level (via operator_project_access):
  project_manager  → full project access
  team_lead        → can manage agents
  agent            → conversations assigned to them
  readonly         → view only
  no_access        → explicitly blocked (override company role)

RBAC matrix should be:
  - Stored in DB
  - Checked at every API endpoint
  - Logged in admin_audit_logs for every access check failure
```

---

## PART 4: EVENT SOURCING REVIEW

**Should the system store all these event types?**

**YES.** An AI platform that learns from historical data MUST have complete event records.

**Recommended Event Architecture:**

```sql
CREATE TABLE domain_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  event_id        UUID UNIQUE NOT NULL DEFAULT uuid_generate_v7(),

  -- What happened
  event_type      VARCHAR(200) NOT NULL,
  -- Taxonomy: {domain}.{entity}.{action}.{version}
  -- Examples:
  --   conversation.message.created.v1
  --   ticket.status.changed.v1
  --   conversation.takeover.acquired.v1
  --   ai.inference.completed.v1
  --   webhook.received.v1
  --   knowledge.document.indexed.v1

  -- Which entity
  aggregate_type  VARCHAR(100) NOT NULL,  -- 'conversation','ticket','webhook','project'
  aggregate_id    VARCHAR(255) NOT NULL,  -- UUID or integer ID

  -- Tenant scope
  project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  company_id      INTEGER REFERENCES companies(id) ON DELETE SET NULL,

  -- Who triggered it
  actor_type      VARCHAR(50),           -- 'customer','operator','ai','system','webhook'
  actor_id        VARCHAR(255),

  -- Full event payload (immutable once written)
  payload         JSONB NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}',

  -- Causality chain
  correlation_id  UUID,                  -- groups related events
  causation_id    UUID,                  -- the event that caused this one
  parent_event_id UUID,

  -- Schema version
  schema_version  VARCHAR(20) NOT NULL DEFAULT 'v1',

  -- Ordering
  sequence_number BIGSERIAL,            -- global ordering
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NOTE: This table should be APPEND-ONLY. No UPDATEs. No DELETEs.
-- Retention: archive after 2 years (move to cold storage)

CREATE INDEX idx_domain_events_aggregate  ON domain_events(aggregate_type, aggregate_id, created_at);
CREATE INDEX idx_domain_events_type       ON domain_events(event_type, created_at DESC);
CREATE INDEX idx_domain_events_project    ON domain_events(project_id, created_at DESC);
CREATE INDEX idx_domain_events_correlation ON domain_events(correlation_id) WHERE correlation_id IS NOT NULL;
```

---

## PART 5: PRODUCTION OPERATIONS

---

### 5.1 SOFT DELETE

**Current state:** NO soft delete on ANY table.

This means: DELETE on any table is permanent and unrecoverable without a database backup.

**Required:** All major tables need `deleted_at TIMESTAMPTZ`.

Tables requiring soft delete:
- conversations ✅ (proposed above)
- messages ✅ (proposed above)
- tickets (add `deleted_at`)
- identities (add `deleted_at`)
- knowledge_documents ✅ (proposed above)
- operators (add `deleted_at`)
- companies (add `deleted_at`)
- projects (add `deleted_at`)

**Implementation rule:** All application queries must include `WHERE deleted_at IS NULL`. Partial indexes on `deleted_at IS NULL` help performance.

### 5.2 IDEMPOTENCY

**Current protection:**
- `messages.external_id` + UNIQUE constraint — protects against duplicate LINE messages
- `outbox_events` has no idempotency key

**Gaps:**
- Webhook layer has no idempotency → `webhook_events` table (proposed above) solves this
- BullMQ job retries can re-process the same webhook → need `webhook_events.idempotency_key`
- Plane.io sync can run twice → `outbox_events` needs `idempotency_key`

### 5.3 ARCHIVING AND RETENTION

**Zero retention policy currently exists.**

**Recommended retention rules:**

| Table | Retention | Action |
|-------|-----------|--------|
| messages | 3 years | Archive to cold storage |
| webhook_events | 90 days | Delete raw payloads, keep metadata |
| ai_inference_logs | 1 year | Aggregate then delete rows |
| traces | 6 months | Archive |
| domain_events | 2 years | Archive to cold storage |
| ai_thinking_traces | 90 days | Delete (sensitive) |
| learning_samples | Indefinite | Keep forever |
| audit_logs | 7 years | Legal requirement |

**Required table:**
```sql
CREATE TABLE retention_policies (
  id            SERIAL PRIMARY KEY,
  table_name    VARCHAR(100) NOT NULL UNIQUE,
  retain_days   INTEGER NOT NULL,
  action        VARCHAR(50) NOT NULL CHECK (action IN ('delete','archive','anonymize')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## PART 6: SCENARIOS — CAN THE SCHEMA HANDLE THESE?

---

**Scenario 1: Customer sends image. Bot cannot understand. Admin takes over. Months later AI learns.**

Current schema: ❌ FAIL

```
Missing:
  1. LINE image URL expires → no permanent storage of image (needs storage_key)
  2. No OCR/Vision result stored → AI cannot learn from image later
  3. No learning_samples table → no pipeline from conversation → training data
  4. No message_media_analysis → no OCR result
  5. No link between media analysis and learning sample

Required fix:
  → webhook_events stores original LINE payload with image URL
  → message_attachments has storage_key (S3 permanent copy)
  → message_media_analysis stores Vision/OCR result
  → learning_samples can be created from this conversation
```

**Scenario 2: PromptX adds GPT Vision later. Can existing stored images be reused?**

Current schema: ❌ FAIL  
After fix: ✅ YES (with `message_media_analysis` + permanent S3 storage)

**Scenario 3: Customer recalls a message.**

Current schema: ⚠️ PARTIAL  
After migration 014: `is_recalled` flag exists, but `original_content` for preservation is missing in current DDL.

**Required:**
```sql
-- Already in proposed messages table above:
is_recalled     BOOLEAN NOT NULL DEFAULT FALSE,
recalled_at     TIMESTAMPTZ,
original_content TEXT   -- content preserved even after recall
```

**Scenario 4: LINE retries webhook — duplicate message?**

Current schema: ⚠️ PARTIAL  
`messages.external_id` UNIQUE constraint prevents duplicate messages in DB.  
BUT: If webhook hits BullMQ twice before worker processes first job, both jobs may try to INSERT — only one succeeds, other throws constraint error. This must be handled at the application layer with `ON CONFLICT DO NOTHING`.

After fix with `webhook_events.idempotency_key`: ✅ Full protection at webhook ingestion layer.

**Scenario 5: Email and WhatsApp added later.**

Current schema: ✅ MOSTLY YES  
Channel system is generic. Adding WhatsApp requires:
- `project_channels` entry with `channel_type='whatsapp'`
- WhatsApp-specific config in `credentials_json` → better to use typed columns
- `identities.channel = 'whatsapp'` — already defined in proposed CHECK

**Scenario 6: Group conversations become collaborative Issue Sessions.**

Current schema: ❌ FAIL  
After proposed fixes: ✅ YES with `group_sessions` + `conversation_participants` + `conversation_handoffs`

---

## PART 7: COMPLETE LIST OF REQUIRED CHANGES

---

### Things That MUST Be Done BEFORE Production (Blocking)

```
BLOCK-1: Resolve identities.id type conflict
  Action: Choose UUID. Migrate all FKs to UUID type.
  Risk of skipping: Production boot failure, FK constraint errors

BLOCK-2: Encrypt project_channels credentials
  Action: AES-256-GCM encryption before first INSERT
  Risk of skipping: Credential breach, GDPR/SOC2 non-compliance

BLOCK-3: Clean messages.content data
  Action: Parse and re-insert all existing messages with clean content field
  Risk of skipping: AI training on garbage data, exponential growth

BLOCK-4: Add webhook_events table (idempotency)
  Action: Run migration before connecting LINE webhook
  Risk of skipping: Duplicate messages under LINE retry, no replay capability

BLOCK-5: Add project_id NOT NULL to document_embeddings
  Action: Backfill then set NOT NULL
  Risk of skipping: Cross-project RAG leakage (security issue)

BLOCK-6: Create operators table (already in 014)
  Action: Already in migration 014 — MUST run 014 first

BLOCK-7: Add soft delete (deleted_at) to all major tables
  Action: ALTER TABLE ADD COLUMN deleted_at TIMESTAMPTZ
  Risk of skipping: Any DELETE is permanent — no recovery without full restore

BLOCK-8: Add domain_events table
  Action: Create append-only event log before going live
  Risk of skipping: No replay, no audit, no event-sourced AI learning

BLOCK-9: Add learning_samples + message_media_analysis tables
  Action: Create before processing first real message
  Risk of skipping: Historical conversations cannot be used for AI training later

BLOCK-10: Fix conversation_participants.identity_id type
  Action: Match identities.id type (UUID)
  Risk of skipping: FK constraint failure
```

### Things That Can Wait (Post-Production)

```
LATER-1: Table partitioning for messages (wait until > 5M rows)
LATER-2: UUID v7 for new tables (implement for new tables, not retroactive)
LATER-3: GDPR erasure procedures (build tooling around existing columns)
LATER-4: Materialized views for analytics
LATER-5: Read replicas for RAG queries
LATER-6: RLS policies (row-level security)
LATER-7: Channel-specific credential tables (refactor from JSONB)
LATER-8: group_sessions table (when group features mature)
LATER-9: AI model A/B testing framework (when prompt v2 exists)
LATER-10: Retention policy automation (implement after 6 months)
```

### Things That Will Become Extremely Expensive After Production

```
EXPENSIVE-1: Changing PRIMARY KEY from SERIAL to UUID
  Cost: Full table rebuild, application code rewrite, zero-downtime migration
  Required for: All tables if you want distributed sharding later

EXPENSIVE-2: Splitting messages table (adding partitioning)
  Cost: Table recreation with partition key, index rebuild
  When: After messages > 10M rows, adding partitioning gets complex

EXPENSIVE-3: Migrating from JSONB credentials to typed encrypted columns
  Cost: Schema migration + application migration + key rotation
  For: project_channels.credentials_json

EXPENSIVE-4: Adding event sourcing AFTER data exists
  Cost: Cannot retroactively replay events you never stored
  Impact: Historical AI learning impossible for period before event log

EXPENSIVE-5: Renaming domain concepts (e.g., "profile" → "customer")
  Cost: All FKs, all application code, all API contracts
  Impact: Massive coordination cost with frontend, integrations

EXPENSIVE-6: Changing identities.id type after data exists
  Cost: Zero-downtime UUID migration requires 3-step process:
        1. Add new UUID column + populate
        2. Update all FK columns
        3. Drop old column + rename
        Estimate: 1-2 days of careful migration
```

---

## PART 8: FINAL RECOMMENDED TABLE INVENTORY

**Tables that must exist at production launch:**

```
Core:
  companies                     ✅ exists
  projects                      ✅ exists
  operators                     ✅ added in 014
  operator_project_access       ✅ added in 014
  profiles                      ✅ exists (needs PII columns)
  identities                    ⚠️ CRITICAL — type conflict must fix

Channel:
  project_channels              ⚠️ credentials not encrypted
  project_prompts               ✅ exists (needs version columns)
  project_sla_policies          ✅ exists
  project_ai_settings           ✅ exists
  project_routing_rules         ✅ exists
  project_business_hours        ✅ exists
  project_holidays              ✅ exists
  project_mcp_permissions       ✅ exists
  project_feature_flags         ✅ exists
  company_holiday_calendars     ✅ added in 014
  company_holidays              ✅ added in 014

Conversation:
  conversations                 ⚠️ needs type fix + handoff columns
  conversation_participants     ✅ added in 014 (needs type fix)
  conversation_handoffs         ❌ MISSING — must create
  messages                      ⚠️ data corruption issue
  message_attachments           ⚠️ needs storage_key + mime_type
  internal_notes                ✅ added in 014
  takeover_sessions             ✅ added in 014

Ticket:
  tickets                       ⚠️ needs SLA columns (014 adds them)
  ticket_events                 ✅ exists
  ticket_embeddings             ✅ exists

Knowledge:
  knowledge_documents           ❌ RENAME from document_embeddings
  knowledge_embeddings          ❌ SPLIT from document_embeddings

Webhook / Events:
  webhook_events                ❌ MISSING — CRITICAL
  domain_events                 ❌ MISSING — CRITICAL
  outbox_events                 ✅ exists (needs aggregate columns)
  conversation_events           ✅ exists

AI / Agent:
  traces                        ✅ exists
  ai_thinking_traces            ✅ added in 014
  ai_inference_logs             ❌ MISSING
  ai_memory                     ✅ added in 014

Learning:
  learning_samples              ❌ MISSING
  message_media_analysis        ❌ MISSING

Operations:
  admin_audit_logs              ✅ exists
  webchat_sessions              ⚠️ FK type broken
  retention_policies            ❌ MISSING (nice-to-have)
```

---

## CONCLUSION

This database is architecturally reachable for production — but it needs approximately **3–5 days of focused engineering** on:

1. Resolving the `identities.id` type war
2. Creating `webhook_events` + `domain_events`
3. Renaming/splitting `document_embeddings` into proper knowledge tables
4. Encrypting channel credentials
5. Cleaning message content corruption
6. Adding soft delete everywhere
7. Creating `learning_samples` + `message_media_analysis` before first real conversation
8. Creating `conversation_handoffs` table
9. Creating `ai_inference_logs` table

**The most expensive mistake** you can make today is to ship without:
- Event sourcing (domain_events)
- Webhook idempotency store
- AI learning infrastructure tables
- Encrypted credentials

These cannot be added retroactively with the same value. Once conversations start flowing and no domain_events are stored, that historical data is gone forever.

---

*Review completed: 2026-07-21*
*Status: ARCHITECTURE FREEZE PENDING — 10 blocking issues must resolve*
*Next action: Engineering team reviews this document, prioritizes BLOCK-1 through BLOCK-10*
