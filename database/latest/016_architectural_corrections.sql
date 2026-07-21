-- ============================================================
-- MIGRATION 016: PRE-PRODUCTION ARCHITECTURAL CORRECTIONS
-- 016_architectural_corrections.sql
-- Date: 2026-07-21
-- Author: Ten-Year Architecture Review
--
-- PURPOSE:
--   Apply 9 structural decisions that are cheap today and
--   extremely expensive after real production data exists.
--
--   This migration does NOT add new features.
--   It corrects aggregate boundaries and coupling issues
--   identified in TEN_YEAR_ARCHITECTURE_REVIEW.md.
--
-- MUST RUN AFTER: migrations 001–015
-- ============================================================

-- ============================================================
-- CHANGE 1: Make tickets.conversation_id nullable
-- --------------------------------------------------------
-- WHY: Tickets (issues) must be able to exist independently
--      of conversations. A ticket can be created from:
--      - A conversation (current)
--      - An email (no conversation)
--      - An API call (no conversation)
--      - An operator manually (no conversation)
--      - A future channel with no "conversation" concept
--
-- EXPENSIVE LATER: ALTER on a table with 1M+ rows risks lock.
-- ============================================================

DO $$
BEGIN
  -- Only modify if column is currently NOT NULL
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tickets'
      AND column_name = 'conversation_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE tickets ALTER COLUMN conversation_id DROP NOT NULL;
    RAISE NOTICE 'tickets.conversation_id is now nullable.';
  ELSE
    RAISE NOTICE 'tickets.conversation_id already nullable — skipping.';
  END IF;
END $$;

-- ============================================================
-- CHANGE 2: conversation_ticket_links junction table
-- --------------------------------------------------------
-- WHY: One ticket may eventually link to multiple conversations
--      (same problem reported via LINE and then followed up by email).
--      One conversation may contain multiple independent tickets.
--
--      This table is the canonical many-to-many join.
--      Seed it from existing tickets.conversation_id data.
--
-- EXPENSIVE LATER: Requires backfill script + query refactoring
--                  after tickets table has millions of rows.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_ticket_links (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ticket_id       INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,

  link_type       VARCHAR(50) NOT NULL DEFAULT 'primary'
                  CHECK (link_type IN (
                    'primary',         -- conversation where ticket was first raised
                    'related',         -- subsequent conversation about same issue
                    'escalated_from',  -- this ticket was created when escalating from another
                    'merged_from'      -- this ticket was merged into another
                  )),

  linked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_by       VARCHAR(20) NOT NULL DEFAULT 'system'
                  CHECK (linked_by IN ('ai','operator','system','api')),

  PRIMARY KEY (conversation_id, ticket_id)
);

-- Seed from existing tickets (backfill current 1:1 relationship)
INSERT INTO conversation_ticket_links (conversation_id, ticket_id, link_type, linked_by)
SELECT
  t.conversation_id,
  t.id,
  'primary',
  'system'
FROM tickets t
WHERE t.conversation_id IS NOT NULL
ON CONFLICT (conversation_id, ticket_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_conv_ticket_links_ticket
  ON conversation_ticket_links(ticket_id);

CREATE INDEX IF NOT EXISTS idx_conv_ticket_links_conv
  ON conversation_ticket_links(conversation_id);

-- ============================================================
-- CHANGE 3: messages.ticket_id — scope messages to issues
-- --------------------------------------------------------
-- WHY: When one conversation contains two independent issues,
--      messages for Issue #2 must be distinguishable from
--      messages for Issue #1 (already resolved).
--
--      Without this column, AgentRuntime has no way to tell
--      "which messages in this 200-message conversation are
--      about the CURRENT active ticket" without scanning content.
--
-- EXPENSIVE LATER: Index build on 10M-row messages table takes hours.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_ticket
  ON messages(ticket_id)
  WHERE ticket_id IS NOT NULL;

-- ============================================================
-- CHANGE 4: messages.message_purpose — separate sender from function
-- --------------------------------------------------------
-- WHY: messages.role mixes WHO sent the message with WHAT the
--      message is for. An operator can send a customer reply
--      (visible) or an internal note (not visible). Both have
--      role='human_operator' but completely different semantics.
--
--      Without message_purpose, AI training cannot distinguish
--      "operator reply" from "internal note" without reading
--      the is_visible_to_customer flag — which is a business rule,
--      not a message classification.
--
-- EXPENSIVE LATER: Cannot retroactively classify 100M messages
--                  without ML classification or manual labeling.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_purpose VARCHAR(50) NOT NULL DEFAULT 'reply';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_purpose_check') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_purpose_check
      CHECK (message_purpose IN (
        'reply',           -- standard reply, visible to customer
        'internal_note',   -- not visible to customer
        'system_event',    -- automated system notification
        'ai_reasoning',    -- AI thinking step (not a reply)
        'escalation_note', -- note written during escalation workflow
        'proactive'        -- AI-initiated outbound message
      ));
  END IF;
END $$;

-- Backfill: internal notes have is_visible_to_customer = FALSE
UPDATE messages
SET message_purpose = 'internal_note'
WHERE is_visible_to_customer = FALSE
  AND message_purpose = 'reply';

-- Backfill: system events
UPDATE messages
SET message_purpose = 'system_event'
WHERE role = 'system'
  AND message_purpose = 'reply';

CREATE INDEX IF NOT EXISTS idx_messages_purpose
  ON messages(conversation_id, message_purpose);

-- ============================================================
-- CHANGE 5: ticket_id on takeover_sessions and conversation_handoffs
-- --------------------------------------------------------
-- WHY: If a conversation contains Issue #1 (resolved) and
--      Issue #2 (active), a human taking over should be scoped
--      to Issue #2, not the entire conversation.
--
--      Without ticket_id on takeover_sessions, the query
--      "show me all takeovers for this type of issue" cannot
--      be answered — only "show me takeovers for this conversation."
--
-- EXPENSIVE LATER: Historical takeover records cannot be
--                  retroactively associated with issue types.
-- ============================================================

ALTER TABLE takeover_sessions
  ADD COLUMN IF NOT EXISTS ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;

ALTER TABLE conversation_handoffs
  ADD COLUMN IF NOT EXISTS ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;

-- Backfill: link takeover sessions to the ticket active at that time
UPDATE takeover_sessions ts
SET ticket_id = (
  SELECT t.id
  FROM tickets t
  WHERE t.conversation_id = ts.conversation_id
    AND t.status NOT IN ('Closed','Resolved','Cancelled')
  ORDER BY t.created_at DESC
  LIMIT 1
)
WHERE ts.ticket_id IS NULL;

-- Same for handoffs
UPDATE conversation_handoffs ch
SET ticket_id = (
  SELECT t.id
  FROM tickets t
  WHERE t.conversation_id = ch.conversation_id
    AND t.status NOT IN ('Closed','Resolved','Cancelled')
  ORDER BY t.created_at DESC
  LIMIT 1
)
WHERE ch.ticket_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_takeover_ticket
  ON takeover_sessions(ticket_id)
  WHERE ticket_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_handoffs_ticket
  ON conversation_handoffs(ticket_id)
  WHERE ticket_id IS NOT NULL;

-- ============================================================
-- CHANGE 6: Ticket self-hierarchy + issue_category + SLA exposure
-- --------------------------------------------------------
-- WHY:
--   parent_ticket_id: enables ticket grouping (epic → issue → sub-task)
--                     and issue clusters without a new table
--   issue_category:   enables AI to learn "what type of problem is this"
--                     — cannot be retroactively classified accurately
--   total_sla_exposure: tracks cumulative SLA time across reopen cycles
--                       — cannot be recalculated if not tracked from start
-- ============================================================

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS parent_ticket_id         INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS issue_category           VARCHAR(100),
  ADD COLUMN IF NOT EXISTS total_sla_exposure_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reopened_count           INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reopened_at         TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tickets_parent
  ON tickets(parent_ticket_id)
  WHERE parent_ticket_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tickets_category
  ON tickets(project_id, issue_category)
  WHERE issue_category IS NOT NULL;

-- ============================================================
-- CHANGE 7: teams table + team_id on projects and operators
-- --------------------------------------------------------
-- WHY: The current Company → Project 2-level hierarchy cannot
--      represent enterprise organizational structure:
--        Company → Division → Team → Project
--
--      Adding a "team" layer after production requires:
--      - Deciding which team each existing project belongs to
--      - Backfilling team assignments for all operators
--      - Updating RBAC policies
--      - API contract changes
--
--      Adding an empty teams table with nullable FKs today
--      costs nothing and enables the hierarchy when needed.
-- ============================================================

CREATE TABLE IF NOT EXISTS teams (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name           VARCHAR(255) NOT NULL,
  description    TEXT,
  parent_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,  -- for nested teams
  status         VARCHAR(50) NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','archived')),
  created_by     INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_teams_company
  ON teams(company_id, status);

-- Optional: associate projects with a team
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL;

-- Optional: associate operators with a primary team
ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS primary_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL;

-- ============================================================
-- CHANGE 8: Identity account type + Profile merge support
-- --------------------------------------------------------
-- WHY 1 (identities.account_type):
--   A LINE company account may be used by multiple employees.
--   The system currently has no way to flag "this identity
--   is a corporate account, not an individual."
--   After production: cannot distinguish individual from corporate
--   customers without reading conversation content.
--
-- WHY 2 (profiles.merged_into_profile_id):
--   If a customer contacts from LINE and then from WhatsApp,
--   their records may initially create two profiles.
--   When merged, we need to know WHICH profile was merged WHERE.
--   Without merge support from Day 1, merging after production
--   creates orphaned FKs (all conversations, tickets, memories
--   pointing to the old profile_id).
-- ============================================================

ALTER TABLE identities
  ADD COLUMN IF NOT EXISTS account_type VARCHAR(50) NOT NULL DEFAULT 'individual'
                           CHECK (account_type IN (
                             'individual',    -- one real person
                             'corporate',     -- multiple people share this identity
                             'bot',           -- automated system identity
                             'internal',      -- operator/employee testing account
                             'anonymous'      -- unverified/temporary identity
                           )),
  ADD COLUMN IF NOT EXISTS is_shared_account BOOLEAN NOT NULL DEFAULT FALSE;

-- Auto-set is_shared_account from account_type
UPDATE identities
SET is_shared_account = TRUE
WHERE account_type = 'corporate';

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS merged_into_profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_merged BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_profiles_merged
  ON profiles(merged_into_profile_id)
  WHERE merged_into_profile_id IS NOT NULL;

-- ============================================================
-- CHANGE 9: ai_memory — add ticket scope
-- --------------------------------------------------------
-- WHY: AI memory currently points to source_conv_id.
--      A customer's recurring printer problem should be remembered
--      at the ISSUE level ("customer often has hardware issues"),
--      not at the conversation level ("customer mentioned printer in conv #47").
--
--      Without ticket_id on ai_memory, the AI cannot distinguish
--      memory that came from a resolved issue vs. an active one.
-- ============================================================

ALTER TABLE ai_memory
  ADD COLUMN IF NOT EXISTS source_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS memory_scope VARCHAR(50) NOT NULL DEFAULT 'conversation'
                           CHECK (memory_scope IN (
                             'conversation',  -- scoped to a specific conversation
                             'issue',         -- scoped to a specific ticket/issue
                             'customer',      -- scoped to the profile (cross-issue)
                             'project'        -- scoped to the project (cross-customer)
                           ));

-- Make source_conv_id nullable (memory can now be issue-scoped without a conversation)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_memory'
      AND column_name = 'source_conv_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE ai_memory ALTER COLUMN source_conv_id DROP NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_memory_ticket
  ON ai_memory(source_ticket_id, memory_scope)
  WHERE source_ticket_id IS NOT NULL;

-- ============================================================
-- ARCHITECTURE DECISION RECORDS (inline comments as ADR)
-- ============================================================

COMMENT ON TABLE conversation_ticket_links IS
  'ADR-001: Canonical many-to-many between conversations and tickets.
   A ticket (issue) can exist without a conversation.
   A conversation can link to multiple tickets.
   This is the authoritative join — prefer over tickets.conversation_id for new queries.';

COMMENT ON COLUMN messages.ticket_id IS
  'ADR-002: Scopes a message to a specific ticket when a conversation
   contains multiple independent issues. NULL = message applies to the
   full conversation context. Set when an issue is identified mid-conversation.';

COMMENT ON COLUMN messages.message_purpose IS
  'ADR-003: Classifies the function of a message, independent of who sent it.
   role = WHO sent it.  message_purpose = WHAT it is for.
   Operators must set this when creating messages via API.
   AI training pipelines use this to distinguish reply vs internal_note.';

COMMENT ON TABLE teams IS
  'ADR-004: Optional organizational hierarchy layer between Company and Project.
   Empty on Day 1. Populated when enterprise customers need Div → Team → Project.
   All FKs to teams are nullable — system works without teams defined.';

COMMENT ON COLUMN tickets.parent_ticket_id IS
  'ADR-005: Self-referential FK for ticket hierarchy (parent issue → sub-issues).
   NULL = root-level issue. Used for: Epic grouping, issue clustering,
   duplicate marking (duplicate_of_ticket_id already exists — this is for hierarchy).';

COMMENT ON COLUMN identities.account_type IS
  'ADR-006: Distinguishes individual identities from corporate/shared accounts.
   A corporate LINE account used by 3 employees should be flagged here.
   Affects: customer display, profile merge logic, AI memory scoping.';

-- ============================================================
-- SUMMARY
-- ============================================================
-- After this migration, the schema supports:
--
-- Issue-centric queries:
--   - SELECT all messages for a ticket across any conversation
--   - SELECT all handoffs for a specific issue type
--   - SELECT all takeovers related to a ticket
--   - SELECT AI memory for a customer's issue category
--
-- Organizational hierarchy:
--   - Company → Team (optional) → Project (already existed)
--   - Operator → primary_team (optional)
--
-- Ticket independence:
--   - tickets.conversation_id is nullable (tickets exist without conversations)
--   - conversation_ticket_links is the join table
--
-- Identity flexibility:
--   - corporate accounts can be flagged
--   - profile merge is supported
--
-- Final Day 1 table count after 001–016: 29 tables
--
-- New tables added in this migration: 2
--   conversation_ticket_links
--   teams
--
-- Total columns added: 18 across 8 tables
-- ============================================================
