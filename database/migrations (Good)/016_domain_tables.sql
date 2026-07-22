-- ============================================================
-- TicketX / PromptX Platform — Migration 016: Domain Tables
-- /database/migrations/016_domain_tables.sql
-- Author: Database Architecture Audit
-- Date: 2026-07-21
-- Purpose: Adds conversation_participants and customer_enrollments + backfill scripts
-- MUST RUN AFTER: 015_day1_minimum_viable.sql
-- ============================================================

-- 0. LEGACY IDENTITY KEY ALIGNMENT
-- The original NoCoDB bootstrap used VARCHAR identity keys. The frozen schema
-- and all new domain tables use INTEGER keys. Convert only when every existing
-- key is numeric; otherwise fail safely without weakening referential integrity.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'identities'
      AND column_name = 'id'
      AND data_type = 'character varying'
  ) THEN
    IF EXISTS (SELECT 1 FROM identities WHERE id !~ '^[0-9]+$')
       OR EXISTS (SELECT 1 FROM conversations WHERE identity_id IS NOT NULL AND identity_id !~ '^[0-9]+$')
       OR EXISTS (SELECT 1 FROM webchat_sessions WHERE identity_id IS NOT NULL AND identity_id !~ '^[0-9]+$') THEN
      RAISE EXCEPTION USING
        ERRCODE = '22018',
        MESSAGE = 'Cannot convert legacy identity keys to INTEGER because non-numeric values exist';
    END IF;

    ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_identity_id_fkey;
    ALTER TABLE webchat_sessions DROP CONSTRAINT IF EXISTS webchat_sessions_identity_id_fkey;

    ALTER TABLE identities ALTER COLUMN id TYPE INTEGER USING id::INTEGER;
    ALTER TABLE conversations ALTER COLUMN identity_id TYPE INTEGER USING identity_id::INTEGER;
    ALTER TABLE webchat_sessions ALTER COLUMN identity_id TYPE INTEGER USING identity_id::INTEGER;

    ALTER TABLE conversations
      ADD CONSTRAINT conversations_identity_id_fkey
      FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE SET NULL;
    ALTER TABLE webchat_sessions
      ADD CONSTRAINT webchat_sessions_identity_id_fkey
      FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE SEQUENCE IF NOT EXISTS identities_id_seq;
ALTER SEQUENCE identities_id_seq OWNED BY identities.id;
SELECT setval('identities_id_seq', COALESCE(MAX(id), 1), COUNT(*) > 0) FROM identities;
ALTER TABLE identities ALTER COLUMN id SET DEFAULT nextval('identities_id_seq');

-- 1. CONVERSATION PARTICIPANTS
CREATE TABLE IF NOT EXISTS conversation_participants (
  id               SERIAL PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  participant_type VARCHAR(50) NOT NULL DEFAULT 'customer' CHECK (participant_type IN ('customer','operator','ai','observer','collaborator')),
  identity_id      INTEGER REFERENCES identities(id) ON DELETE SET NULL,
  operator_id      INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  session_role     VARCHAR(50) NOT NULL DEFAULT 'member' CHECK (session_role IN ('reporter','owner','collaborator','observer','ai_handler','member')),
  join_source      VARCHAR(50) NOT NULL DEFAULT 'direct' CHECK (join_source IN ('direct','invited','webhook','escalation','takeover','system')),
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at          TIMESTAMPTZ,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  channel_metadata JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT participant_has_single_owner CHECK (
    (identity_id IS NOT NULL AND operator_id IS NULL AND participant_type != 'ai') OR
    (operator_id IS NOT NULL AND identity_id IS NULL AND participant_type != 'ai') OR
    (participant_type = 'ai' AND identity_id IS NULL AND operator_id IS NULL)
  ),
  UNIQUE (conversation_id, identity_id),
  UNIQUE (conversation_id, operator_id)
);

CREATE INDEX IF NOT EXISTS idx_participants_conv_active ON conversation_participants(conversation_id, is_active) WHERE is_active = TRUE;

-- 2. CUSTOMER ENROLLMENTS
CREATE TABLE IF NOT EXISTS customer_enrollments (
  id                SERIAL PRIMARY KEY,
  profile_id        INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  enrollment_source VARCHAR(50) NOT NULL DEFAULT 'first_contact' CHECK (enrollment_source IN ('first_contact','imported','invited','proactive','api')),
  enrollment_type   VARCHAR(50) NOT NULL DEFAULT 'customer' CHECK (enrollment_type IN ('customer','vip','internal','blocked')),
  first_contact_at  TIMESTAMPTZ,
  enrolled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enrolled_by       INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  notes             TEXT,
  UNIQUE (profile_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_profile ON customer_enrollments(profile_id, is_active);

-- 3. BACKFILL: Seed Participants from existing conversations
INSERT INTO conversation_participants (conversation_id, project_id, participant_type, identity_id, session_role, join_source, joined_at)
SELECT c.id, c.project_id, 'customer', c.identity_id, 'reporter', 'direct', c.created_at
FROM conversations c
WHERE c.identity_id IS NOT NULL
ON CONFLICT (conversation_id, identity_id) DO NOTHING;

-- 4. BACKFILL: Seed Enrollments from existing profiles
INSERT INTO customer_enrollments (profile_id, project_id, company_id, enrollment_source, first_contact_at, enrolled_at)
SELECT DISTINCT ON (pr.id, c.project_id)
  pr.id, c.project_id, p.company_id, 'first_contact', MIN(c.created_at) OVER (PARTITION BY pr.id, c.project_id), MIN(c.created_at) OVER (PARTITION BY pr.id, c.project_id)
FROM conversations c
JOIN identities i ON i.id = c.identity_id
JOIN profiles pr ON pr.id = i.profile_id
JOIN projects p ON p.id = c.project_id
WHERE c.identity_id IS NOT NULL
ON CONFLICT (profile_id, project_id) DO NOTHING;
