-- ============================================================
-- TicketX / PromptX Platform — Migration 014: Production Readiness
-- /database/migrations/014_production_readiness.sql
-- Author: Database Architecture Audit
-- Date: 2026-07-21
-- Purpose: Adds operators, takeover_sessions, internal_notes, and company holidays
-- MUST RUN AFTER: 013_message_uniqueness.sql
-- ============================================================

-- 1. OPERATORS TABLE
CREATE TABLE IF NOT EXISTS operators (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email         VARCHAR(255) NOT NULL,
  name          VARCHAR(255) NOT NULL,
  display_name  VARCHAR(255),
  avatar_url    TEXT,
  role          VARCHAR(50) NOT NULL DEFAULT 'agent' CHECK (role IN ('super_admin','admin','manager','agent','readonly')),
  status        VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','suspended')),
  password_hash TEXT,
  last_login_at TIMESTAMPTZ,
  settings      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, email)
);

CREATE TABLE IF NOT EXISTS operator_project_access (
  operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        VARCHAR(50) NOT NULL DEFAULT 'agent' CHECK (role IN ('manager','agent','readonly')),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by  INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  PRIMARY KEY (operator_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_operators_company ON operators(company_id, status);
CREATE INDEX IF NOT EXISTS idx_operators_email ON operators(email);

-- 2. TAKEOVER SESSIONS
CREATE TABLE IF NOT EXISTS takeover_sessions (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  operator_id     INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status          VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','expired','force_released')),
  acquired_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  released_at     TIMESTAMPTZ,
  release_reason  VARCHAR(100),
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_takeover_conv_status ON takeover_sessions(conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_takeover_operator ON takeover_sessions(operator_id, acquired_at DESC);

-- 3. INTERNAL NOTES
CREATE TABLE IF NOT EXISTS internal_notes (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ticket_id       INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  operator_id     INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  is_pinned       BOOLEAN NOT NULL DEFAULT FALSE,
  mentioned_ops   INTEGER[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notes_conv ON internal_notes(conversation_id, created_at DESC);

-- 4. COMPANY HOLIDAYS
CREATE TABLE IF NOT EXISTS company_holiday_calendars (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         VARCHAR(255) NOT NULL,
  country_code VARCHAR(10) NOT NULL DEFAULT 'TH',
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_holidays (
  id           SERIAL PRIMARY KEY,
  calendar_id  INTEGER NOT NULL REFERENCES company_holiday_calendars(id) ON DELETE CASCADE,
  holiday_date DATE NOT NULL,
  name         VARCHAR(255) NOT NULL,
  holiday_type VARCHAR(50) NOT NULL DEFAULT 'public' CHECK (holiday_type IN ('public','company','regional','optional')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (calendar_id, holiday_date)
);

ALTER TABLE project_business_hours
  ADD COLUMN IF NOT EXISTS holiday_calendar_id INTEGER REFERENCES company_holiday_calendars(id) ON DELETE SET NULL;

-- 5. CONVERSATIONS OPERATOR LINK
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS takeover_state VARCHAR(50) NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;

-- 6. TICKETS OPERATOR LINK & SLA EXTENSIONS
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sla_breach_at TIMESTAMPTZ;

-- 7. AUDIT LOGS OPERATOR LINK
ALTER TABLE admin_audit_logs
  ADD COLUMN IF NOT EXISTS operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL;

-- 8. AI MEMORY (Long-Term Memory)
CREATE TABLE IF NOT EXISTS ai_memory (
  id               SERIAL PRIMARY KEY,
  profile_id       INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  memory_type      VARCHAR(50) NOT NULL CHECK (memory_type IN ('preference','fact','issue','resolution','context')),
  key              VARCHAR(255) NOT NULL,
  value            TEXT NOT NULL,
  value_embedding  TEXT,
  source_conv_id   INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  source_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  confidence       NUMERIC(3,2) NOT NULL DEFAULT 1.00,
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
