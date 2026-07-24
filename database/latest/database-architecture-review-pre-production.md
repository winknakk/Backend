# Database Architecture Review — TicketX / PromptX Platform
## Pre-Production Database Audit

**วันที่:** 20 กรกฎาคม 2569  
**Reviewed by:** Principal Database Architect (AI Review)  
**Scope:** PostgreSQL — ทุก Migration ตั้งแต่ 001 ถึง 013  
**Context:** Production deployment — PromptX จะ connect ตรงกับ PostgreSQL แทน localhost JSON

---

## 🏆 Database Health Score: **5.5 / 10**

```
Normalization:          6/10   (ดี แต่มีปัญหา type inconsistency)
Relationships:          5/10   (FK ขาดหลายจุด)
Indexes:                4/10   (Composite indexes ขาดมาก)
Security (Encryption):  2/10   (Plaintext secrets — Critical Risk)
Scalability:            5/10   (Multi-tenant OK, HA pending)
Media Support:          3/10   (Attachment table อยู่แต่ไม่ครบ)
AI/Agent Compatibility: 6/10   (Trace OK, Memory missing)
Future Milestone Ready: 4/10   (หลาย milestone ยังขาด tables)
```

---

## 🔴 Production Readiness: **NOT READY — 8 Critical Issues**

```
CRITICAL (ต้องแก้ก่อน deploy):
  C1 — project_channels.secret_token เก็บ plaintext
  C2 — identities.id type inconsistency (VARCHAR vs INTEGER)
  C3 — messages.content เก็บ JSON object string แทน parsed content
  C4 — conversations.assigned_pm เป็น VARCHAR ไม่มี FK
  C5 — outbox_events ไม่มี FK บ่งบอกว่า relate กับ entity อะไร
  C6 — webchat_sessions.identity_id FK type ไม่ตรง
  C7 — ไม่มี operator/admin users table
  C8 — holidays เป็น project-scoped แต่ไม่รองรับ company-level calendar chain

HIGH (ควรแก้ก่อน production):
  H1 — Missing: conversation_participants table (Group conversations)
  H2 — Missing: message_types (image/audio/video/sticker/file support)
  H3 — Missing: ai_memory table (Long-term agent memory)
  H4 — Missing: internal_notes table
  H5 — Missing: takeover_sessions table
  H6 — Missing: ai_thinking_traces table
  H7 — Missing: company_holiday_calendars table
  H8 — conversations: ไม่มี updated_at trigger
```

---

## 1. การวิเคราะห์ทุก Table — ปัญหาและคำแนะนำ

---

### TABLE: `companies`

**DDL ปัจจุบัน:**
```sql
CREATE TABLE companies (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**ปัญหาที่พบ:**

| Issue | Severity | รายละเอียด |
|-------|---------|-----------|
| ขาด `slug` | Medium | ไม่มี unique identifier สำหรับ URL routing |
| ขาด `status` | Medium | ไม่รู้ว่า company active/suspended |
| ขาด `plan_tier` | Medium | ไม่รองรับ Enterprise pricing tiers |
| ขาด `settings_json` | Low | ไม่มี company-level global config |
| ขาด `updated_at` | Low | ไม่รู้เมื่อ company record เปลี่ยน |
| ขาด index บน `name` | Low | Full table scan เมื่อ search by name |

**DDL ที่แนะนำ:**
```sql
CREATE TABLE companies (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  slug       VARCHAR(100) UNIQUE NOT NULL,        -- URL-safe identifier
  plan_tier  VARCHAR(50) DEFAULT 'starter'        -- starter/pro/enterprise
             CHECK (plan_tier IN ('starter','professional','enterprise')),
  status     VARCHAR(50) DEFAULT 'active'
             CHECK (status IN ('active','suspended','churned')),
  settings   JSONB DEFAULT '{}',                  -- company-level config
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_companies_slug   ON companies(slug);
CREATE INDEX idx_companies_status ON companies(status);
```

**Migration difficulty:** Easy — additive columns  
**Production impact:** None (backward compatible)

---

### TABLE: `projects`

**DDL ปัจจุบัน:**
```sql
CREATE TABLE projects (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER REFERENCES companies(id),
  name         VARCHAR(255) NOT NULL,
  project_type VARCHAR(100) DEFAULT 'Support',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
-- Migration 007 เพิ่ม: environment VARCHAR(255), project_type VARCHAR(255)
```

**ปัญหาที่พบ:**

| Issue | Severity | รายละเอียด |
|-------|---------|-----------|
| `company_id` Nullable | High | project ที่ไม่มี company owner ไม่ควรมีอยู่ |
| ขาด cascade rule | High | DELETE company → projects ไม่ถูก handle |
| ขาด `status` | Medium | ไม่รู้ว่า project active/archived |
| ขาด `slug` | Medium | ไม่มี URL-safe identifier |
| ขาด `updated_at` | Low | audit trail ไม่ครบ |
| `project_type` ซ้ำใน 001 และ 007 | Low | Column declared twice |

**DDL ที่แนะนำ:**
```sql
CREATE TABLE projects (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         VARCHAR(255) NOT NULL,
  slug         VARCHAR(100) NOT NULL,
  project_type VARCHAR(50) DEFAULT 'support'
               CHECK (project_type IN ('support','sales','internal','demo')),
  status       VARCHAR(50) DEFAULT 'active'
               CHECK (status IN ('active','archived','suspended')),
  timezone     VARCHAR(100) DEFAULT 'Asia/Bangkok',
  settings     JSONB DEFAULT '{}',
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, slug)
);

CREATE INDEX idx_projects_company_id ON projects(company_id);
CREATE INDEX idx_projects_status     ON projects(status);
```

---

### TABLE: `profiles`

**DDL ปัจจุบัน:**
```sql
CREATE TABLE profiles (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  name       VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**ปัญหาที่พบ:**

| Issue | Severity | รายละเอียด |
|-------|---------|-----------|
| `name` Nullable | High | Customer ไม่มีชื่อทำให้ UI แสดงผลผิด |
| ขาด `email` | High | ไม่มี contact information |
| ขาด `phone` | Medium | ไม่รองรับ WhatsApp phone lookup |
| ขาด `metadata_json` | Medium | ไม่มีที่เก็บ custom attributes |
| ขาด `source_channel` | Medium | ไม่รู้ว่า profile มาจาก channel ไหน |
| ขาด `updated_at` | Low | audit trail ไม่ครบ |

**DDL ที่แนะนำ:**
```sql
CREATE TABLE profiles (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name           VARCHAR(255) NOT NULL DEFAULT 'Unknown Customer',
  display_name   VARCHAR(255),                     -- Override display name
  email          VARCHAR(255),
  phone          VARCHAR(50),
  avatar_url     TEXT,
  locale         VARCHAR(20) DEFAULT 'th',
  timezone       VARCHAR(100) DEFAULT 'Asia/Bangkok',
  metadata       JSONB DEFAULT '{}',               -- Custom CRM attributes
  source_channel VARCHAR(50),                      -- 'line'/'whatsapp'/'email'
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_profiles_company_id ON profiles(company_id);
CREATE INDEX idx_profiles_email      ON profiles(email) WHERE email IS NOT NULL;
CREATE INDEX idx_profiles_phone      ON profiles(phone) WHERE phone IS NOT NULL;
```

---

### TABLE: `identities` ⚠️ CRITICAL TYPE INCONSISTENCY

**ปัญหา Critical:**

```
001_initial_schema.sql:    id SERIAL PRIMARY KEY (INTEGER)
nocodb_to_postgresql.sql:  id VARCHAR(50) PRIMARY KEY  ← CONFLICT!
007_webchat_support.sql:   identity_id VARCHAR(255) REFERENCES identities(id)
seed_dev.sql:              identities.id = '1' (string)
conversations:             identity_id INTEGER REFERENCES identities(id) ← CONFLICT!
```

**Impact:** FK constraint จะ fail ถ้า identities.id เป็น INTEGER แต่ conversations reference ด้วย VARCHAR หรือกลับกัน นี่คือ **data type mismatch** ที่อาจทำให้ production boot fail

**DDL ที่ถูกต้อง:**
```sql
-- ควรเป็น UUID เพื่อรองรับ distributed systems
CREATE TABLE identities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  channel     VARCHAR(50) NOT NULL
              CHECK (channel IN ('line','whatsapp','email','webchat','line_group','instagram','telegram')),
  channel_ref VARCHAR(255) NOT NULL,     -- External channel user ID
  display_name VARCHAR(255),             -- Channel display name (LINE name, WA name)
  avatar_url   TEXT,
  metadata     JSONB DEFAULT '{}',
  verified_at  TIMESTAMPTZ,             -- Identity verified timestamp
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (channel, channel_ref)
);

CREATE INDEX idx_identities_profile_id   ON identities(profile_id);
CREATE INDEX idx_identities_channel_ref  ON identities(channel, channel_ref);
```

**Migration difficulty:** Hard — requires updating all FK references  
**Production impact:** High — must migrate before go-live

---

### TABLE: `conversations`

**DDL ปัจจุบัน:**
```sql
CREATE TABLE conversations (
  id          SERIAL PRIMARY KEY,
  identity_id INTEGER REFERENCES identities(id),
  project_id  INTEGER REFERENCES projects(id),
  channel     VARCHAR(50) NOT NULL,
  status      VARCHAR(50) DEFAULT 'open',
  handled_by  VARCHAR(50) DEFAULT 'ai',
  assigned_pm VARCHAR(255),    -- ← VARCHAR ไม่มี FK!
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
-- nocodb: promptx_conversation_id VARCHAR(100) UNIQUE
```

**ปัญหาที่พบ:**

| Issue | Severity | รายละเอียด |
|-------|---------|-----------|
| `assigned_pm` เป็น VARCHAR | Critical | ไม่มี FK — operator อาจถูกลบจาก DB แต่ conversation ยัง reference |
| ขาด `conversation_type` | High | ไม่รู้ว่าเป็น 1-1, group, multi-participant |
| ขาด `group_id` | High | Group conversations ไม่มีที่ reference |
| ขาด `takeover_state` | High | Takeover ใช้ Redis แต่ไม่มี persistent state ใน DB |
| ขาด `closed_at` | High | ไม่รู้ว่า conversation ปิดเมื่อไร (SLA calculation) |
| ขาด `last_message_at` | High | ไม่มีสำหรับ sorting inbox โดย recency |
| `status` ไม่มี CHECK | Medium | ใส่ค่าอะไรก็ได้ |
| ขาด `updated_at` trigger | Medium | ไม่อัพเดทอัตโนมัติ |
| ขาด index บน `project_id, status` | Medium | Inbox query จะ slow |

**DDL ที่แนะนำ:**
```sql
CREATE TABLE conversations (
  id                      SERIAL PRIMARY KEY,
  identity_id             UUID REFERENCES identities(id) ON DELETE SET NULL,
  project_id              INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel                 VARCHAR(50) NOT NULL,
  conversation_type       VARCHAR(50) DEFAULT 'direct'
                          CHECK (conversation_type IN ('direct','group','multi_party')),
  status                  VARCHAR(50) DEFAULT 'open'
                          CHECK (status IN ('open','pending','escalated','resolved','closed')),
  handled_by              VARCHAR(20) DEFAULT 'ai'
                          CHECK (handled_by IN ('ai','human','bot','system')),
  operator_id             INTEGER REFERENCES operators(id) ON DELETE SET NULL,  -- FK!
  group_identity_id       UUID REFERENCES identities(id) ON DELETE SET NULL,    -- For group
  promptx_conversation_id VARCHAR(100) UNIQUE,
  takeover_state          VARCHAR(50) DEFAULT 'none'
                          CHECK (takeover_state IN ('none','requested','active','released')),
  takeover_operator_id    INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  takeover_expires_at     TIMESTAMPTZ,
  last_message_at         TIMESTAMPTZ,
  closed_at               TIMESTAMPTZ,
  metadata                JSONB DEFAULT '{}',
  updated_at              TIMESTAMPTZ DEFAULT NOW(),
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_conversations_project_status ON conversations(project_id, status);
CREATE INDEX idx_conversations_identity       ON conversations(identity_id);
CREATE INDEX idx_conversations_last_message   ON conversations(last_message_at DESC);
CREATE INDEX idx_conversations_operator       ON conversations(operator_id) WHERE operator_id IS NOT NULL;
```

---

### TABLE: `messages` ⚠️ CRITICAL DATA INTEGRITY ISSUE

**ปัญหา Critical ที่พบในข้อมูลจริง:**

ดูจาก seed data ใน `nocodb_to_postgresql.sql`:
```
content = '{"formatted":"Customer: ระบบล่ม...","count":3}'
```

**AI ใส่ JSON object string เข้าไปใน TEXT column แทนที่จะ parse แล้วเก็บ clean content**

นี่คือ **data corruption pattern** ที่ทำให้:
1. AI context history นำไปใช้งานยาก (ต้อง parse ซ้อน parse)
2. ข้อมูล exponential growth — JSON ฝัง JSON ฝัง JSON จะโต O(n²)
3. ไม่รองรับ media messages (image/audio/sticker)

**DDL ปัจจุบัน:**
```sql
CREATE TABLE messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id),
  role            VARCHAR(50) NOT NULL,
  content         TEXT,                    -- ← ปัญหา: เก็บ JSON string
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  -- Migration 013:
  external_id     VARCHAR(255),
  UNIQUE (conversation_id, external_id)
);
```

**DDL ที่แนะนำ (Generic Message Table):**
```sql
CREATE TABLE messages (
  id                SERIAL PRIMARY KEY,
  conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  
  -- Identity
  role              VARCHAR(20) NOT NULL
                    CHECK (role IN ('customer','ai','human','system','bot','internal')),
  sender_type       VARCHAR(20) NOT NULL DEFAULT 'unknown'
                    CHECK (sender_type IN ('customer','operator','ai','system')),
  sender_id         VARCHAR(255),          -- operator_id or identity channel_ref
  
  -- Content (Generic)
  message_type      VARCHAR(50) NOT NULL DEFAULT 'text'
                    CHECK (message_type IN (
                      'text','image','audio','video','file','sticker',
                      'location','template','carousel','quick_reply',
                      'internal_note','system_event','ai_thinking'
                    )),
  content           TEXT,                  -- Plain text content ONLY
  content_json      JSONB DEFAULT '{}',   -- Structured content for rich messages
  
  -- Media (reference to message_attachments)
  has_attachment    BOOLEAN DEFAULT FALSE,
  
  -- Message State
  external_id       VARCHAR(255),          -- Channel message ID (LINE/WA)
  is_recalled       BOOLEAN DEFAULT FALSE,
  recalled_at       TIMESTAMPTZ,
  edited_at         TIMESTAMPTZ,
  
  -- AI Metadata  
  ai_model          VARCHAR(100),
  ai_confidence     NUMERIC(4,3),
  processing_ms     INTEGER,
  
  -- Visibility
  is_visible_to_customer BOOLEAN DEFAULT TRUE,
  is_visible_to_operator BOOLEAN DEFAULT TRUE,
  
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (conversation_id, external_id)
);

CREATE INDEX idx_messages_conversation_created ON messages(conversation_id, created_at ASC);
CREATE INDEX idx_messages_role                 ON messages(conversation_id, role);
CREATE INDEX idx_messages_type                 ON messages(message_type);
CREATE INDEX idx_messages_sender               ON messages(sender_id) WHERE sender_id IS NOT NULL;
```

---

### TABLE: `tickets`

**สถานะปัจจุบัน:** หลาย migrations ทับกัน (001 → 004 → 006 → 010 → 011)

**โครงสร้างที่ได้ (สุดท้ายหลังทุก migration):**
```
id, ticket_id (UNIQUE), conversation_id, project_id, subject, summary,
status, priority, severity, assigned_pm, created_via, plane_issue_id,
due_date, created_at, title, original_problem_statement,
running_summary, last_ai_summary, duplicate_of_ticket_id,
duplicate_score, duplicate_reason, ai_confidence_metrics,
searchable_text, enrichment_state
```

**ปัญหาที่พบ:**

| Issue | Severity | รายละเอียด |
|-------|---------|-----------|
| `assigned_pm` เป็น VARCHAR | Critical | ไม่มี FK เหมือน conversations |
| `project_id` Nullable ใน 004 | High | Ticket ไม่มี project owner — multi-tenant จะ leak |
| `status` ไม่มี CHECK constraint | High | ใส่ค่าอะไรก็ได้ |
| `priority` ไม่มี CHECK constraint | High | P1/P2 ไม่ได้ enforce ใน DB layer |
| ขาด `resolved_at`, `closed_at` | High | คำนวณ SLA resolution time ไม่ได้ |
| ขาด `sla_breached` flag | High | ไม่รู้ว่า ticket breach SLA หรือไม่ |
| ขาด `response_at` | High | ไม่รู้ว่า first response เมื่อไร (SLA) |
| `plane_issue_id` เป็น VARCHAR | Medium | ควรเป็น UUID type ตาม Plane.io schema |
| ขาด index บน `status, project_id` | Medium | Ticket list query จะ slow |

**DDL ที่แนะนำ:**
```sql
-- เพิ่ม columns ที่ขาด (migration):
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breach_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS response_sla_hours INTEGER,
  ADD COLUMN IF NOT EXISTS resolution_sla_hours INTEGER,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ DEFAULT NOW();

-- Fix: project_id NOT NULL
ALTER TABLE tickets ALTER COLUMN project_id SET NOT NULL;

-- Add CHECK constraints
ALTER TABLE tickets
  ADD CONSTRAINT tickets_status_check
    CHECK (status IN ('Open','In Progress','Resolved','Closed','Duplicate','Cancelled')),
  ADD CONSTRAINT tickets_priority_check
    CHECK (priority IN ('P1','P2','P3','P4')),
  ADD CONSTRAINT tickets_severity_check
    CHECK (severity IN ('Critical','High','Medium','Low'));

-- Fix: Drop VARCHAR assigned_pm, add FK
ALTER TABLE tickets DROP COLUMN IF EXISTS assigned_pm;
ALTER TABLE tickets ADD COLUMN operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL;

-- Missing indexes
CREATE INDEX idx_tickets_project_status   ON tickets(project_id, status);
CREATE INDEX idx_tickets_due_date         ON tickets(due_date) WHERE status NOT IN ('Resolved','Closed');
CREATE INDEX idx_tickets_sla_breach       ON tickets(sla_breached) WHERE sla_breached = TRUE;
CREATE INDEX idx_tickets_operator         ON tickets(operator_id) WHERE operator_id IS NOT NULL;
```

---

### TABLE: `document_embeddings`

**ปัญหาที่พบ:**

| Issue | Severity | รายละเอียด |
|-------|---------|-----------|
| ขาด `project_id` FK | Critical | ข้อมูล vector search ไม่ isolated per project |
| ขาด `company_id` | High | ไม่รองรับ company-level knowledge sharing |
| ขาด `document_type` | High | ไม่รู้ว่าเป็น FAQ, manual, policy, etc. |
| ขาด `source_url` | Medium | ไม่รู้ source ของ document |
| ขาด `chunk_index` | Medium | ไม่รู้ chunk ที่เท่าไรของ original doc |
| ขาด `is_active` | Medium | ไม่สามารถ disable document โดยไม่ลบ |
| ivfflat index ยังไม่ระบุ `lists` | Medium | Performance ไม่ optimal |

**DDL ที่แนะนำ:**
```sql
CREATE TABLE document_embeddings (
  id             SERIAL PRIMARY KEY,
  doc_id         VARCHAR(255) NOT NULL,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_type  VARCHAR(50) DEFAULT 'knowledge'
                 CHECK (document_type IN ('knowledge','policy','faq','manual','procedure','ticket_history')),
  title          VARCHAR(500),
  content        TEXT NOT NULL,
  source_url     TEXT,
  chunk_index    INTEGER DEFAULT 0,
  chunk_total    INTEGER DEFAULT 1,
  metadata       JSONB DEFAULT '{}',
  language       VARCHAR(20) DEFAULT 'th',
  is_active      BOOLEAN DEFAULT TRUE,
  embedding      VECTOR(1536) NOT NULL,
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (doc_id, chunk_index)
);

-- Multi-tenant isolation index (CRITICAL)
CREATE INDEX idx_doc_embeddings_project ON document_embeddings(project_id, is_active);

-- Optimized ivfflat index with lists
CREATE INDEX idx_doc_embeddings_vector
  ON document_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

---

### TABLE: `project_channels` ⚠️ CRITICAL SECURITY ISSUE

**ปัญหา Critical:**
```sql
secret_token TEXT,          -- ← PLAINTEXT!
credentials_json JSONB,     -- ← PLAINTEXT!
```

LINE Channel Secret, WhatsApp Access Token เก็บแบบ **plaintext ใน database**

**Impact:** Database breach → expose credential ทุก channel ของทุก project  
**Compliance:** GDPR, SOC2 — NON-COMPLIANT

**DDL ที่แนะนำ:**
```sql
CREATE TABLE project_channels (
  id                    SERIAL PRIMARY KEY,
  project_id            INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_type          VARCHAR(50) NOT NULL
                        CHECK (channel_type IN ('line','whatsapp','email','webchat','instagram','telegram')),
  channel_id            VARCHAR(255) NOT NULL,
  channel_name          VARCHAR(255),
  
  -- AES-256-GCM Encrypted fields
  secret_token_encrypted TEXT,          -- encrypted
  credentials_encrypted  TEXT,          -- encrypted JSON
  encryption_key_id      VARCHAR(100),  -- KMS key reference
  
  webhook_url           TEXT,
  verify_token          VARCHAR(255),
  active                BOOLEAN DEFAULT TRUE,
  last_verified_at      TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, channel_type, channel_id)
);
```

---

### TABLE: `project_holidays`

**ปัญหา:** Holiday เป็น project-scoped แต่ขาด company-level calendar chain

**ปัจจุบัน:**
```
Company → Project → project_holidays (per-project)
```

**ที่ควรเป็น:**
```
Company → company_holidays (national/company holidays)
        → Project → project_holidays (project-specific overrides)
```

**เหตุผล:** วันหยุดนักขัตฤกษ์ไทย (Songkran, New Year ฯลฯ) ควร set ระดับ company ครั้งเดียว แล้ว inherit ลงมาทุก project แทนที่จะ duplicate ทุก project

**DDL ที่แนะนำ:**
```sql
-- Company-level holiday calendar
CREATE TABLE company_holiday_calendars (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,        -- "Thailand Public Holidays 2026"
  country_code  VARCHAR(10) DEFAULT 'TH',
  is_default    BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE company_holidays (
  id              SERIAL PRIMARY KEY,
  calendar_id     INTEGER NOT NULL REFERENCES company_holiday_calendars(id) ON DELETE CASCADE,
  holiday_date    DATE NOT NULL,
  name            VARCHAR(255) NOT NULL,
  holiday_type    VARCHAR(50) DEFAULT 'public'
                  CHECK (holiday_type IN ('public','company','regional')),
  is_full_day     BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (calendar_id, holiday_date)
);

-- Project inherits from a company calendar + can override
ALTER TABLE project_business_hours
  ADD COLUMN IF NOT EXISTS holiday_calendar_id INTEGER
    REFERENCES company_holiday_calendars(id) ON DELETE SET NULL;
```

---

### TABLE: `outbox_events` ⚠️ MISSING ENTITY REFERENCE

**ปัญหา:**
```sql
CREATE TABLE outbox_events (
  id          SERIAL PRIMARY KEY,
  event_type  VARCHAR(255) NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  status      VARCHAR(50) NOT NULL DEFAULT 'pending',
  attempts    INT NOT NULL DEFAULT 0,
  ...
);
```

ไม่มี column ที่บอกว่า event นี้เกี่ยวกับ entity อะไร (ticket? conversation? project?) ทำให้ query "outbox events for ticket X" ไม่ได้โดยตรง

**DDL ที่แนะนำ:**
```sql
ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS aggregate_type VARCHAR(100),   -- 'ticket','conversation','project'
  ADD COLUMN IF NOT EXISTS aggregate_id   VARCHAR(255),   -- entity ID
  ADD COLUMN IF NOT EXISTS project_id     INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS next_retry_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processed_at   TIMESTAMPTZ;

CREATE INDEX idx_outbox_status_retry   ON outbox_events(status, next_retry_at)
  WHERE status IN ('pending','failed');
CREATE INDEX idx_outbox_aggregate      ON outbox_events(aggregate_type, aggregate_id);
```

---

### TABLE: `traces`

**ปัญหาที่พบ:**

| Issue | Severity | รายละเอียด |
|-------|---------|-----------|
| `conversation_id` เป็น VARCHAR(255) | High | ไม่มี FK กลับ conversations table |
| `parent_trace_id` เป็น VARCHAR | Medium | ไม่มี FK — tree structure ไม่ validate |
| ขาด `project_id` | High | ไม่รู้ว่า trace belong to project ไหน |
| ขาด `token_count` | Medium | ไม่รู้ token usage (cost tracking) |
| ขาด `cost_usd` | Medium | ไม่รู้ API cost |
| ขาด index บน `called_at` | Medium | Time-range query จะ slow |

**DDL ที่แนะนำ:**
```sql
ALTER TABLE traces
  ADD COLUMN IF NOT EXISTS project_id       INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS token_input      INTEGER,
  ADD COLUMN IF NOT EXISTS token_output     INTEGER,
  ADD COLUMN IF NOT EXISTS cost_usd         NUMERIC(10,6),
  ADD COLUMN IF NOT EXISTS latency_ms       INTEGER;

-- Fix: Add proper index on called_at for time-range queries
CREATE INDEX idx_traces_called_at  ON traces(called_at DESC);
CREATE INDEX idx_traces_project    ON traces(project_id, called_at DESC)
  WHERE project_id IS NOT NULL;
```

---

### TABLE: `webchat_sessions`

**ปัญหา Critical:**
```sql
identity_id VARCHAR(255) NOT NULL REFERENCES identities(id)
```
`identities.id` อาจเป็น SERIAL (INTEGER) ใน migration 001 แต่ `webchat_sessions` reference ด้วย VARCHAR — **FK type mismatch**

**DDL ที่แนะนำ:**
```sql
CREATE TABLE webchat_sessions (
  id              SERIAL PRIMARY KEY,
  identity_id     UUID NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_token   VARCHAR(512) UNIQUE NOT NULL,
  user_agent      TEXT,
  ip_address      INET,
  expires_at      TIMESTAMPTZ,
  last_active_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

---

### TABLE: `message_attachments`

**ปัจจุบัน (migration 007):**
```sql
CREATE TABLE message_attachments (
  id         SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_url   VARCHAR(2048) NOT NULL,
  file_name  VARCHAR(255) NOT NULL,
  file_type  VARCHAR(100),       -- ← ควรเป็น MIME type
  file_size  INTEGER,            -- ← bytes, ควรเป็น BIGINT
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**ปัญหา:**

| Issue | Severity | รายละเอียด |
|-------|---------|-----------|
| ขาด `mime_type` | High | file_type ไม่ structured — ควรเป็น MIME |
| `file_size` เป็น INTEGER | Medium | Integer overflow สำหรับไฟล์ > 2GB |
| ขาด `storage_provider` | Medium | ไม่รู้ว่าเก็บใน S3/GCS/local |
| ขาด `storage_key` | Medium | ไม่มี path ใน object storage |
| ขาด `thumbnail_url` | Medium | ไม่มี preview image สำหรับ video/image |
| ขาด `duration_seconds` | Low | สำหรับ audio/video |
| ขาด `width`, `height` | Low | สำหรับ image dimensions |
| ขาด index | Medium | ไม่มี index บน message_id |
| ขาด virus scan status | Medium | Enterprise requirement |

**DDL ที่แนะนำ:**
```sql
CREATE TABLE message_attachments (
  id                SERIAL PRIMARY KEY,
  message_id        INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  
  -- File identification
  file_name         VARCHAR(500) NOT NULL,
  mime_type         VARCHAR(100) NOT NULL,        -- 'image/jpeg','application/pdf'
  file_size         BIGINT,                       -- bytes
  
  -- Storage
  storage_provider  VARCHAR(50) DEFAULT 'local'
                    CHECK (storage_provider IN ('local','s3','gcs','azure_blob')),
  storage_key       TEXT,                         -- path in storage
  file_url          TEXT NOT NULL,                -- public/signed URL
  thumbnail_url     TEXT,                         -- for image/video preview
  
  -- Media metadata
  duration_seconds  INTEGER,                      -- for audio/video
  width             INTEGER,                      -- for images/video
  height            INTEGER,
  
  -- Security
  is_safe           BOOLEAN,                      -- virus scan result
  scanned_at        TIMESTAMPTZ,
  
  -- Media category
  attachment_type   VARCHAR(50) DEFAULT 'file'
                    CHECK (attachment_type IN ('image','audio','video','document','sticker','location')),
  
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_attachments_message_id ON message_attachments(message_id);
CREATE INDEX idx_attachments_type       ON message_attachments(attachment_type);
```

---

## 2. Missing Tables — ต้องสร้างก่อน Production

---

### MISSING TABLE 1: `operators` (Critical)

ไม่มี users/operators table เลย! `assigned_pm` ใน tickets/conversations เป็นแค่ VARCHAR string

```sql
CREATE TABLE operators (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email         VARCHAR(255) NOT NULL,
  name          VARCHAR(255) NOT NULL,
  display_name  VARCHAR(255),
  avatar_url    TEXT,
  role          VARCHAR(50) DEFAULT 'agent'
                CHECK (role IN ('super_admin','admin','manager','agent','readonly')),
  status        VARCHAR(50) DEFAULT 'active'
                CHECK (status IN ('active','inactive','suspended')),
  password_hash TEXT,                          -- bcrypt hash
  last_login_at TIMESTAMPTZ,
  settings      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, email)
);

-- Operator ↔ Project access control
CREATE TABLE operator_project_access (
  operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        VARCHAR(50) DEFAULT 'agent',
  granted_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (operator_id, project_id)
);

CREATE INDEX idx_operators_company ON operators(company_id, status);
CREATE INDEX idx_operators_email   ON operators(email);
```

---

### MISSING TABLE 2: `conversation_participants` (Milestone 3)

สำหรับ Group Conversation / Multi-participant:

```sql
CREATE TABLE conversation_participants (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  identity_id     UUID REFERENCES identities(id) ON DELETE SET NULL,
  participant_type VARCHAR(50) DEFAULT 'customer'
                   CHECK (participant_type IN ('customer','operator','ai','observer')),
  joined_at       TIMESTAMPTZ DEFAULT NOW(),
  left_at         TIMESTAMPTZ,
  is_active       BOOLEAN DEFAULT TRUE,
  role            VARCHAR(50) DEFAULT 'member'
                  CHECK (role IN ('owner','admin','member')),
  UNIQUE (conversation_id, identity_id)
);

CREATE INDEX idx_participants_conversation ON conversation_participants(conversation_id);
CREATE INDEX idx_participants_identity     ON conversation_participants(identity_id);
```

---

### MISSING TABLE 3: `ai_memory` (Milestone 9)

Long-term AI memory สำหรับ cross-conversation context:

```sql
CREATE TABLE ai_memory (
  id              SERIAL PRIMARY KEY,
  profile_id      INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  memory_type     VARCHAR(50) NOT NULL
                  CHECK (memory_type IN ('preference','fact','issue','resolution','context')),
  key             VARCHAR(255) NOT NULL,
  value           TEXT NOT NULL,
  value_embedding VECTOR(1536),            -- for semantic search
  source_conv_id  INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  source_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  confidence      NUMERIC(3,2) DEFAULT 1.00,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ai_memory_profile_project ON ai_memory(profile_id, project_id);
CREATE INDEX idx_ai_memory_type_key        ON ai_memory(project_id, memory_type, key);
```

---

### MISSING TABLE 4: `takeover_sessions` (Milestone 5)

Persistent takeover record (Redis เป็น ephemeral):

```sql
CREATE TABLE takeover_sessions (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  operator_id     INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id),
  status          VARCHAR(50) DEFAULT 'active'
                  CHECK (status IN ('active','released','expired','force_released')),
  acquired_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  released_at     TIMESTAMPTZ,
  release_reason  VARCHAR(100),
  notes           TEXT
);

CREATE INDEX idx_takeover_conversation ON takeover_sessions(conversation_id, status);
CREATE INDEX idx_takeover_operator     ON takeover_sessions(operator_id, acquired_at DESC);
```

---

### MISSING TABLE 5: `internal_notes` (Milestone 5)

Internal operator notes ที่ customer ไม่เห็น:

```sql
CREATE TABLE internal_notes (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ticket_id       INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  operator_id     INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  is_pinned       BOOLEAN DEFAULT FALSE,
  mentioned_ops   INTEGER[] DEFAULT '{}',    -- operator IDs mentioned
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notes_conversation ON internal_notes(conversation_id, created_at DESC);
CREATE INDEX idx_notes_ticket       ON internal_notes(ticket_id) WHERE ticket_id IS NOT NULL;
```

---

### MISSING TABLE 6: `ai_thinking_traces` (Milestone 6)

PromptX Agent reasoning trace ที่ละเอียดกว่า `traces` table:

```sql
CREATE TABLE ai_thinking_traces (
  id              SERIAL PRIMARY KEY,
  trace_id        UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  project_id      INTEGER NOT NULL REFERENCES projects(id),
  
  -- Agent reasoning
  thinking_content TEXT,           -- Raw chain-of-thought
  reasoning_steps  JSONB DEFAULT '[]',
  tool_calls       JSONB DEFAULT '[]',
  
  -- Decision
  final_action     VARCHAR(100),   -- 'reply','escalate','create_ticket','search_docs'
  confidence_score NUMERIC(4,3),
  
  -- Performance
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  latency_ms       INTEGER,
  model_name       VARCHAR(100),
  
  -- Safety
  policy_flags     JSONB DEFAULT '[]',    -- safety violations detected
  guardrail_result VARCHAR(50),           -- 'pass','block','warn'
  
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ai_traces_conversation ON ai_thinking_traces(conversation_id, created_at DESC);
CREATE INDEX idx_ai_traces_project      ON ai_thinking_traces(project_id, created_at DESC);
```

---

### MISSING TABLE 7: `company_holiday_calendars` (Holiday Management)

(ดูรายละเอียดใน section project_holidays ด้านบน)

---

## 3. Future Milestone Compatibility

| Milestone | Feature | Schema Ready? | หมายเหตุ |
|-----------|---------|--------------|---------|
| M3: Group Conversation | conversation_participants | ❌ Missing table | ต้องสร้าง |
| M3: Multi-participant | message with sender info | ⚠️ Partial | ต้องเพิ่ม sender_id |
| M4: Knowledge Search | document_embeddings | ⚠️ Partial | ขาด project_id FK |
| M4: Knowledge Memory | ai_memory | ❌ Missing table | ต้องสร้าง |
| M4: Conversation Context | messages + conversation_events | ✅ OK | |
| M5: Human Takeover | takeover_sessions | ❌ Missing table | Redis only ≠ persistent |
| M5: Admin Reply | messages (human role) | ⚠️ Partial | ขาด operator_id FK |
| M5: Internal Notes | internal_notes | ❌ Missing table | ต้องสร้าง |
| M6: Agent Runtime | traces + ai_thinking_traces | ⚠️ Partial | ขาด thinking traces |
| M7: Workflow Automation | outbox_events | ⚠️ Partial | ขาด aggregate reference |
| M8: Analytics | tickets + conversation_events | ⚠️ Partial | ขาด time metrics |
| M9: AI Memory | ai_memory | ❌ Missing table | ต้องสร้าง |
| M9: Semantic Search | document_embeddings | ⚠️ Partial | ขาด project isolation |
| M10: Enterprise | operators + RBAC | ❌ Partial | operators table missing |

---

## 4. Media Support Architecture

**คำแนะนำ: ใช้ Generic Message + Separate Attachments Table**

เหตุผล:
- Message table ควรเป็น generic — type ระบุว่า text/image/audio/video
- Attachments แยกออกมาเพราะ 1 message อาจมีหลาย attachments
- Admin UI และ AI ต้องอ่าน attachments ได้

**Flow ที่แนะนำสำหรับ media:**
```
Customer ส่ง image/file
    │
    ▼
Fastify receives multipart/webhook
    │
    ├── Store file → S3/GCS → get storage_key + public_url
    │
    ├── INSERT messages (type='image', content=caption)
    │
    └── INSERT message_attachments (file_url, storage_key, mime_type, ...)
    
AI อ่าน:
    SELECT m.*, ma.file_url, ma.mime_type
    FROM messages m
    LEFT JOIN message_attachments ma ON ma.message_id = m.id
    WHERE m.conversation_id = $1
    ORDER BY m.created_at ASC
```

**Admin UI:** แสดง image inline, PDF iframe, audio player ตาม attachment_type  
**AI Reference:** ใช้ file_url ส่งไปยัง vision model (GPT-4o, Gemini vision) สำหรับ image analysis

---

## 5. Missing Indexes (สรุป)

| Table | Missing Index | Query ที่ช้า |
|-------|-------------|------------|
| conversations | `(project_id, status, last_message_at)` | Inbox loading |
| conversations | `(operator_id)` | My conversations |
| messages | `(conversation_id, created_at ASC)` | Chat history |
| tickets | `(project_id, status, due_date)` | Ticket list |
| tickets | `(sla_breached, due_date)` | SLA dashboard |
| document_embeddings | `(project_id, is_active)` | RAG search |
| outbox_events | `(status, next_retry_at)` | Worker polling |
| traces | `(project_id, called_at DESC)` | Analytics |
| ticket_events | `(ticket_id, created_at ASC)` | Timeline |

---

## 6. Recommended DDL Migration (014)

**Priority: ต้องทำก่อน Production**

```sql
-- FILE: 014_production_readiness.sql

-- 1. Create operators table (CRITICAL - no FK possible without this)
CREATE TABLE IF NOT EXISTS operators (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email         VARCHAR(255) NOT NULL,
  name          VARCHAR(255) NOT NULL,
  role          VARCHAR(50) DEFAULT 'agent'
                CHECK (role IN ('super_admin','admin','manager','agent','readonly')),
  status        VARCHAR(50) DEFAULT 'active'
                CHECK (status IN ('active','inactive','suspended')),
  password_hash TEXT,
  last_login_at TIMESTAMPTZ,
  settings      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, email)
);

-- 2. Fix conversations: add proper columns
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS conversation_type VARCHAR(50) DEFAULT 'direct',
  ADD COLUMN IF NOT EXISTS operator_id       INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS takeover_state    VARCHAR(50) DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS last_message_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at         TIMESTAMPTZ;

-- 3. Fix tickets: add SLA tracking columns
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS operator_id          INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_response_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breached         BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ DEFAULT NOW();

-- 4. Fix messages: add generic content columns
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_type     VARCHAR(50) DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS sender_type      VARCHAR(20) DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS content_json     JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_recalled      BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_visible_to_customer BOOLEAN DEFAULT TRUE;

-- 5. Fix document_embeddings: add project isolation (CRITICAL for RAG)
ALTER TABLE document_embeddings
  ADD COLUMN IF NOT EXISTS project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS company_id    INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS document_type VARCHAR(50) DEFAULT 'knowledge',
  ADD COLUMN IF NOT EXISTS is_active     BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS title         VARCHAR(500),
  ADD COLUMN IF NOT EXISTS language      VARCHAR(20) DEFAULT 'th';

-- 6. Fix outbox_events: add aggregate reference
ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS aggregate_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS aggregate_id   VARCHAR(255),
  ADD COLUMN IF NOT EXISTS project_id     INTEGER REFERENCES projects(id),
  ADD COLUMN IF NOT EXISTS next_retry_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processed_at   TIMESTAMPTZ;

-- 7. Create missing indexes
CREATE INDEX IF NOT EXISTS idx_conv_project_status_last
  ON conversations(project_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_operator
  ON conversations(operator_id) WHERE operator_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_project_status
  ON tickets(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_sla
  ON tickets(sla_breached, due_date) WHERE sla_breached = TRUE;
CREATE INDEX IF NOT EXISTS idx_doc_embed_project_active
  ON document_embeddings(project_id, is_active);
CREATE INDEX IF NOT EXISTS idx_outbox_status_retry
  ON outbox_events(status, next_retry_at) WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS idx_traces_project_time
  ON traces(project_id, called_at DESC) WHERE project_id IS NOT NULL;

-- 8. Create conversation_participants table
CREATE TABLE IF NOT EXISTS conversation_participants (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  identity_id     VARCHAR(255),
  operator_id     INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  participant_type VARCHAR(50) DEFAULT 'customer',
  joined_at       TIMESTAMPTZ DEFAULT NOW(),
  left_at         TIMESTAMPTZ,
  is_active       BOOLEAN DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_participants_conv
  ON conversation_participants(conversation_id, is_active);

-- 9. Create takeover_sessions table
CREATE TABLE IF NOT EXISTS takeover_sessions (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  operator_id     INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id),
  status          VARCHAR(50) DEFAULT 'active',
  acquired_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  released_at     TIMESTAMPTZ,
  release_reason  VARCHAR(100)
);
CREATE INDEX IF NOT EXISTS idx_takeover_conv
  ON takeover_sessions(conversation_id, status);

-- 10. Create internal_notes table
CREATE TABLE IF NOT EXISTS internal_notes (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ticket_id       INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  operator_id     INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  is_pinned       BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notes_conv
  ON internal_notes(conversation_id, created_at DESC);

-- 11. Create company holiday calendars
CREATE TABLE IF NOT EXISTS company_holiday_calendars (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         VARCHAR(255) NOT NULL,
  country_code VARCHAR(10) DEFAULT 'TH',
  is_default   BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_holidays (
  id           SERIAL PRIMARY KEY,
  calendar_id  INTEGER NOT NULL REFERENCES company_holiday_calendars(id) ON DELETE CASCADE,
  holiday_date DATE NOT NULL,
  name         VARCHAR(255) NOT NULL,
  holiday_type VARCHAR(50) DEFAULT 'public',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (calendar_id, holiday_date)
);

-- 12. Enhance message_attachments
ALTER TABLE message_attachments
  ADD COLUMN IF NOT EXISTS mime_type         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS storage_provider  VARCHAR(50) DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS storage_key       TEXT,
  ADD COLUMN IF NOT EXISTS thumbnail_url     TEXT,
  ADD COLUMN IF NOT EXISTS attachment_type   VARCHAR(50) DEFAULT 'file',
  ADD COLUMN IF NOT EXISTS duration_seconds  INTEGER,
  ADD COLUMN IF NOT EXISTS width             INTEGER,
  ADD COLUMN IF NOT EXISTS height            INTEGER,
  ADD COLUMN IF NOT EXISTS is_safe           BOOLEAN,
  ADD COLUMN IF NOT EXISTS scanned_at        TIMESTAMPTZ;

-- Cast file_size to BIGINT if currently INTEGER
ALTER TABLE message_attachments
  ALTER COLUMN file_size TYPE BIGINT;
```

---

## 7. Future Compatibility Score: **5/10**

| Feature | Supported | ต้องทำอะไร |
|---------|-----------|-----------|
| Image Messages | ⚠️ | message_type + attachments (partial) |
| File Attachments | ⚠️ | อยู่แล้วแต่ขาด storage metadata |
| Audio Messages | ⚠️ | ต้องเพิ่ม duration_seconds, mime_type |
| Sticker Messages | ⚠️ | ต้องเพิ่ม message_type='sticker' |
| Rich Messages | ⚠️ | ต้องเพิ่ม content_json column |
| Message Recall | ❌ | ต้องเพิ่ม is_recalled flag |
| Message Edit | ❌ | ต้องเพิ่ม edited_at |
| Conversation Timeline | ✅ | conversation_events มีแล้ว |
| Human Reply Timeline | ⚠️ | ต้องมี operator_id บน messages |
| Bot Reply Timeline | ✅ | role='ai' มีแล้ว |
| Internal Notes | ❌ | Missing table |
| AI Thinking Trace | ❌ | Missing table |
| Tool Call Trace | ✅ | traces table มีแล้ว |

---

## 8. High Priority Actions (ต้องทำก่อน Deploy)

```
Priority 1 — Block deployment:
  ✍️ สร้าง operators table
  ✍️ เพิ่ม project_id (NOT NULL) บน document_embeddings
  ✍️ Encrypt project_channels.secret_token (AES-256-GCM)
  ✍️ Fix identities.id type inconsistency (choose UUID or INTEGER)
  ✍️ Run migration 014_production_readiness.sql

Priority 2 — Milestone 1-5:
  ✍️ conversation_participants table
  ✍️ takeover_sessions table
  ✍️ internal_notes table
  ✍️ messages: เพิ่ม message_type, sender_type, content_json
  ✍️ company_holiday_calendars table
  ✍️ message_attachments: เพิ่ม mime_type, storage_key, attachment_type

Priority 3 — Milestone 6-10:
  ✍️ ai_memory table
  ✍️ ai_thinking_traces table
  ✍️ operator_project_access table
  ✍️ conversation: เพิ่ม last_message_at index
```

---

## 9. Nice-to-Have Improvements

- **Audit Triggers:** `updated_at` auto-update triggers ทุก table
- **Row-Level Security (RLS):** PostgreSQL RLS policies บน `project_id` columns
- **Table Partitioning:** `messages` partition by `created_at` (เมื่อ > 1M rows)
- **Materialized Views:** pre-computed analytics views (ticket resolution times, etc.)
- **UUID v7:** เปลี่ยน SERIAL PKs เป็น UUID v7 สำหรับ distributed-friendly ordering
- **Schema versioning:** เพิ่ม `schema_versions` tracking table

---

## 10. SLA Architecture Verification

**ปัจจุบัน: Company → Project → project_sla_policies → SLA calculation**

ขาดข้อมูลที่ต้องใช้คำนวณ SLA จริง:
- `tickets.first_response_at` — ❌ ไม่มี
- `tickets.resolved_at` — ❌ ไม่มี  
- `project_business_hours.holiday_calendar_id` — ❌ ไม่มี
- Company-level holiday calendar — ❌ ไม่มี

**SLA Chain ที่ควรเป็น:**
```
Ticket created_at
    │
    ├── + project_sla_policies.response_hours (during business hours)
    │   - skip project_holidays (project override)
    │   - skip company_holidays (inherited calendar)
    │   = response_due_at
    │
    ├── + project_sla_policies.resolve_hours (during business hours)
    │   = resolution_due_at = tickets.due_date
    │
    └── Monitor: tickets.first_response_at vs response_due_at
                 tickets.resolved_at vs tickets.due_date
```

---

*End of Database Architecture Review*  
*Review Date: 20 July 2026*  
*Next Review: After migration 014 deployment*
