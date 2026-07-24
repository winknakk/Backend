-- ============================================================
-- TicketX / PromptX Platform — Context Mapping Layer Schema
-- /database/schema/07_context_mapping.sql
-- Target Database: PostgreSQL 16+
-- ============================================================

-- 1. CONVERSATION TICKET LINKS (Integration Link between Messaging & Support Contexts)
CREATE TABLE IF NOT EXISTS conversation_ticket_links (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ticket_id       INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  link_type       VARCHAR(50) NOT NULL DEFAULT 'primary' CHECK (link_type IN ('primary','related','escalated_from','merged_from')),
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_by       VARCHAR(20) NOT NULL DEFAULT 'system' CHECK (linked_by IN ('ai','operator','system','api')),
  UNIQUE (conversation_id, ticket_id)
);

COMMENT ON TABLE conversation_ticket_links IS 'ADR-003 Integration Link owned by Context Mapping Layer to connect Conversations and Tickets';

CREATE INDEX idx_conv_ticket_links_ticket ON conversation_ticket_links(ticket_id);
CREATE INDEX idx_conv_ticket_links_conv ON conversation_ticket_links(conversation_id);

-- 2. CONVERSATION PARTICIPANTS (Participant collection for IssueSessions and Conversations)
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

COMMENT ON TABLE conversation_participants IS 'Participant membership collection for IssueSessions and Conversations';

CREATE INDEX idx_participants_conv_active ON conversation_participants(conversation_id, is_active) WHERE is_active = TRUE;
CREATE INDEX idx_participants_identity ON conversation_participants(identity_id) WHERE identity_id IS NOT NULL;
CREATE INDEX idx_participants_operator ON conversation_participants(operator_id) WHERE operator_id IS NOT NULL;

-- 3. OPERATOR PROJECT ACCESS (RBAC Junction)
CREATE TABLE IF NOT EXISTS operator_project_access (
  operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        VARCHAR(50) NOT NULL DEFAULT 'agent' CHECK (role IN ('manager','agent','readonly')),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by  INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  PRIMARY KEY (operator_id, project_id)
);

-- 4. PROFILE PROJECTS (Legacy Junction)
CREATE TABLE IF NOT EXISTS profile_projects (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (profile_id, project_id)
);
