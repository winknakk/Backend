-- ============================================================
-- TicketX / PromptX Platform — Migration 017: Architectural Corrections
-- /database/migrations/017_architectural_corrections.sql
-- Author: Database Architecture Audit
-- Date: 2026-07-21
-- Purpose: Makes tickets.conversation_id nullable, adds conversation_ticket_links,
--          messages.ticket_id, messages.message_purpose, teams, identity evolution
-- MUST RUN AFTER: 016_domain_tables.sql
-- ============================================================

-- 1. MAKE tickets.conversation_id NULLABLE
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tickets'
      AND column_name = 'conversation_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE tickets ALTER COLUMN conversation_id DROP NOT NULL;
  END IF;
END $$;

-- 2. CONVERSATION TICKET LINKS JUNCTION TABLE
CREATE TABLE IF NOT EXISTS conversation_ticket_links (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ticket_id       INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  link_type       VARCHAR(50) NOT NULL DEFAULT 'primary' CHECK (link_type IN ('primary','related','escalated_from','merged_from')),
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_by       VARCHAR(20) NOT NULL DEFAULT 'system' CHECK (linked_by IN ('ai','operator','system','api')),
  UNIQUE (conversation_id, ticket_id)
);

INSERT INTO conversation_ticket_links (conversation_id, ticket_id, link_type, linked_by)
SELECT conversation_id, id, 'primary', 'system'
FROM tickets
WHERE conversation_id IS NOT NULL
ON CONFLICT (conversation_id, ticket_id) DO NOTHING;

-- 3. SCOPE MESSAGES TO TICKETS & PURPOSE
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS message_purpose VARCHAR(50) NOT NULL DEFAULT 'reply';

-- 4. SCOPE TAKEOVERS & HANDOFFS TO TICKETS
ALTER TABLE takeover_sessions
  ADD COLUMN IF NOT EXISTS ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;

ALTER TABLE conversation_handoffs
  ADD COLUMN IF NOT EXISTS ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;

-- 5. TEAMS (ORGANIZATIONAL HIERARCHY)
CREATE TABLE IF NOT EXISTS teams (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name           VARCHAR(255) NOT NULL,
  description    TEXT,
  parent_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  status         VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by     INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS primary_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL;

-- 6. TICKET HIERARCHY & SLA EXPOSURE
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS parent_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS issue_category VARCHAR(100),
  ADD COLUMN IF NOT EXISTS total_sla_exposure_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reopened_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reopened_at TIMESTAMPTZ;

-- 7. IDENTITY & PROFILE EVOLUTION
ALTER TABLE identities
  ADD COLUMN IF NOT EXISTS account_type VARCHAR(50) NOT NULL DEFAULT 'individual',
  ADD COLUMN IF NOT EXISTS is_shared_account BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS merged_into_profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_merged BOOLEAN NOT NULL DEFAULT FALSE;

-- 8. AI MEMORY TICKET SCOPE
ALTER TABLE ai_memory
  ADD COLUMN IF NOT EXISTS source_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS memory_scope VARCHAR(50) NOT NULL DEFAULT 'conversation';
