-- ============================================================
-- MIGRATION 015-B: DAY 1 SCHEMA ADDITIONS
-- 015b_domain_tables.sql
-- Date: 2026-07-21
-- Author: Schema Philosophy Debate — Architecture Decision
--
-- Adds two tables that were initially deferred but reinstated
-- after domain modeling review:
--
--   1. conversation_participants
--      Reason: Core aggregate collection of IssueSession domain.
--      Not a group chat feature. Exists from first conversation.
--
--   2. customer_enrollments
--      Reason: Explicit profile-project membership.
--      Replaces the semantically empty `profile_projects` junction.
--
-- MUST RUN AFTER: migrations 014 and 015-revised
-- ============================================================

-- ============================================================
-- TABLE 1: conversation_participants
-- Designed for IssueSession domain, not just group conversations
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_participants (
  id               SERIAL PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Who is this participant?
  participant_type VARCHAR(50) NOT NULL DEFAULT 'customer'
                   CHECK (participant_type IN (
                     'customer',        -- end customer (from a channel)
                     'operator',        -- human agent / project manager
                     'ai',              -- AI agent (PromptX)
                     'observer',        -- read-only stakeholder
                     'collaborator'     -- invited internal participant
                   )),

  -- FK to actual entity — only one should be non-null per row
  identity_id      INTEGER REFERENCES identities(id) ON DELETE SET NULL,   -- customer
  operator_id      INTEGER REFERENCES operators(id)  ON DELETE SET NULL,   -- human agent

  -- IssueSession role (richer than just 'member' / 'owner')
  session_role     VARCHAR(50) NOT NULL DEFAULT 'member'
                   CHECK (session_role IN (
                     'reporter',        -- customer who initiated the issue
                     'owner',           -- operator responsible for resolution
                     'collaborator',    -- additional human contributor
                     'observer',        -- read-only
                     'ai_handler',      -- AI currently handling this conversation
                     'member'           -- generic (for group/direct without explicit role)
                   )),

  -- How did this participant enter the conversation?
  join_source      VARCHAR(50) NOT NULL DEFAULT 'direct'
                   CHECK (join_source IN (
                     'direct',          -- opened or sent first message
                     'invited',         -- added by operator
                     'webhook',         -- joined via channel event (e.g. LINE group join)
                     'escalation',      -- added during escalation flow
                     'takeover',        -- joined as operator via takeover
                     'system'           -- added by system or AI decision
                   )),

  -- Participation timeline
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at          TIMESTAMPTZ,              -- NULL means still active
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,

  -- Channel-specific metadata (e.g. LINE group member type: 'sender', 'groupAdmin')
  channel_metadata JSONB NOT NULL DEFAULT '{}',

  -- Constraint: each participant is EITHER an identity OR an operator OR an AI
  CONSTRAINT participant_has_single_owner CHECK (
    (identity_id IS NOT NULL AND operator_id IS NULL AND participant_type != 'ai') OR
    (operator_id IS NOT NULL AND identity_id IS NULL AND participant_type != 'ai') OR
    (participant_type = 'ai' AND identity_id IS NULL AND operator_id IS NULL)
  ),

  -- A person/operator can appear only once per conversation (as active participant)
  UNIQUE (conversation_id, identity_id),
  UNIQUE (conversation_id, operator_id)
);

CREATE INDEX IF NOT EXISTS idx_participants_conv_active
  ON conversation_participants(conversation_id, is_active)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_participants_identity
  ON conversation_participants(identity_id)
  WHERE identity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_participants_operator
  ON conversation_participants(operator_id)
  WHERE operator_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_participants_project
  ON conversation_participants(project_id, participant_type);

-- ============================================================
-- BACKFILL: Seed one participant per existing conversation
-- from the current conversations.identity_id column
-- ============================================================

INSERT INTO conversation_participants (
  conversation_id,
  project_id,
  participant_type,
  identity_id,
  session_role,
  join_source,
  joined_at
)
SELECT
  c.id,
  c.project_id,
  'customer',
  c.identity_id,
  'reporter',
  'direct',
  c.created_at
FROM conversations c
WHERE c.identity_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM conversation_participants cp
    WHERE cp.conversation_id = c.id
      AND cp.identity_id = c.identity_id
  );

-- Backfill: Seed AI participant for all existing conversations
-- (The AI has always been a participant — we just didn't model it)
INSERT INTO conversation_participants (
  conversation_id,
  project_id,
  participant_type,
  identity_id,
  operator_id,
  session_role,
  join_source,
  joined_at
)
SELECT
  c.id,
  c.project_id,
  'ai',
  NULL,
  NULL,
  'ai_handler',
  'system',
  c.created_at
FROM conversations c
WHERE NOT EXISTS (
  SELECT 1 FROM conversation_participants cp
  WHERE cp.conversation_id = c.id
    AND cp.participant_type = 'ai'
);

-- Backfill: If conversation has an operator assigned, seed operator participant
INSERT INTO conversation_participants (
  conversation_id,
  project_id,
  participant_type,
  operator_id,
  session_role,
  join_source,
  joined_at
)
SELECT
  c.id,
  c.project_id,
  'operator',
  c.operator_id,
  'owner',
  'takeover',
  COALESCE(c.updated_at, c.created_at)
FROM conversations c
WHERE c.operator_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM conversation_participants cp
    WHERE cp.conversation_id = c.id
      AND cp.operator_id = c.operator_id
  );

-- ============================================================
-- TABLE 2: customer_enrollments
-- Replaces the semantically empty `profile_projects` junction
-- Explicit profile-project membership with enrollment context
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_enrollments (
  id               SERIAL PRIMARY KEY,
  profile_id       INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- How did this enrollment originate?
  enrollment_source VARCHAR(50) NOT NULL DEFAULT 'first_contact'
                    CHECK (enrollment_source IN (
                      'first_contact',    -- first message from this profile to this project
                      'imported',         -- bulk imported from CRM or NoCoDB
                      'invited',          -- operator explicitly invited
                      'proactive',        -- platform-initiated outbound enrollment
                      'api'               -- enrolled via external API call
                    )),

  -- What is the relationship type?
  enrollment_type  VARCHAR(50) NOT NULL DEFAULT 'customer'
                   CHECK (enrollment_type IN (
                     'customer',          -- standard customer
                     'vip',              -- flagged for priority handling / SLA override
                     'internal',          -- employee / internal tester
                     'blocked'            -- blocked from this project
                   )),

  -- Timing
  first_contact_at TIMESTAMPTZ,           -- populated from first conversation.created_at
  enrolled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enrolled_by      INTEGER REFERENCES operators(id) ON DELETE SET NULL,

  -- State
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  notes            TEXT,

  -- Prevent duplicates: one enrollment record per profile per project
  UNIQUE (profile_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_profile
  ON customer_enrollments(profile_id, is_active);

CREATE INDEX IF NOT EXISTS idx_enrollments_project
  ON customer_enrollments(project_id, enrollment_type)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_enrollments_company
  ON customer_enrollments(company_id);

-- ============================================================
-- BACKFILL: Seed enrollments from existing conversation data
-- Every profile that has ever messaged a project is enrolled.
-- ============================================================

INSERT INTO customer_enrollments (
  profile_id,
  project_id,
  company_id,
  enrollment_source,
  first_contact_at,
  enrolled_at
)
SELECT DISTINCT ON (pr.id, c.project_id)
  pr.id              AS profile_id,
  c.project_id,
  p.company_id,
  'first_contact'    AS enrollment_source,
  MIN(c.created_at) OVER (PARTITION BY pr.id, c.project_id) AS first_contact_at,
  MIN(c.created_at) OVER (PARTITION BY pr.id, c.project_id) AS enrolled_at
FROM conversations c
JOIN identities i  ON i.id  = c.identity_id
JOIN profiles pr   ON pr.id = i.profile_id
JOIN projects p    ON p.id  = c.project_id
WHERE c.identity_id IS NOT NULL
ON CONFLICT (profile_id, project_id) DO NOTHING;

-- ============================================================
-- MIGRATION NOTE: profile_projects
-- ============================================================
-- The original `profile_projects` table from nocodb migration
-- is now superseded by `customer_enrollments`.
-- Do NOT drop profile_projects until data audit confirms
-- all records are captured in customer_enrollments.
--
-- After audit, run:
-- DROP TABLE IF EXISTS profile_projects CASCADE;
-- ============================================================

-- ============================================================
-- FINAL TABLE COUNT — Day 1 Frozen Schema
-- ============================================================
--
-- After migrations 014 + 015 + 015b:
--
-- CORE TENANT (5):
--   companies, projects, operators, profiles, identities
--
-- PROJECT CONFIG (6):
--   project_channels, project_prompts, project_sla_policies,
--   project_ai_settings, project_business_hours, project_holidays
--
-- FEATURE FLAGS (1):
--   project_feature_flags
--
-- CONVERSATION (8):
--   conversations, conversation_participants, conversation_handoffs,
--   messages, message_attachments,
--   takeover_sessions, conversation_events
--   (internal_notes → M3 / migration 017)
--
-- CUSTOMER (1):
--   customer_enrollments
--
-- TICKET (2):
--   tickets, ticket_events
--
-- KNOWLEDGE (2):
--   knowledge_documents, knowledge_embeddings
--
-- OPERATIONS (4):
--   webhook_events, outbox_events, traces, admin_audit_logs
--
-- TOTAL: 29 tables
--
-- (28 tables if operator_project_access is deferred pending RBAC middleware)
-- ============================================================
