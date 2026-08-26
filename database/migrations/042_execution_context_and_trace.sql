-- ============================================================
-- Migration 042: Server-owned execution context (B-0) and causal trace (B-5)
-- ============================================================
--
-- B-0 ------------------------------------------------------------------
-- The Support Agent is handed the conversation id inside its prompt, and the
-- MCP create_ticket tool accepts conversation_id as an agent-supplied
-- argument, then derives org_id and project_id from it. The model therefore
-- controls the value that determines tenant authority, through a channel that
-- also carries attacker-controlled customer text.
--
-- This cannot be fixed with prompt wording. "Never change conversation_id" is
-- an instruction, not a boundary.
--
-- execution_contexts is the boundary. Trusted backend code creates a row
-- AFTER LINE signature verification and identity/project/conversation
-- resolution. Tenant facts live in that row, not in anything the agent can
-- say. The agent presents an opaque capability token; the server reads the
-- tenant from the row the token names and ignores whatever the agent claimed.
--
-- The token is a capability, not an assertion: possessing it proves the
-- holder is acting inside THIS execution. An agent only ever possesses the
-- token for its own execution, and a customer cannot forge one because it is
-- HMAC-signed server-side.
--
-- B-5 ------------------------------------------------------------------
-- Nothing records PromptX or AgentX execution ids, so "this ticket was
-- created because of that AgentX execution" is unprovable. trace_events is an
-- append-only chain: every row carries a correlation id and the id of its
-- parent, so a ticket can be walked back to the LINE event that caused it.
--
-- External ids are recorded when a component supplies one and left null when
-- it does not. A null is honest; a fabricated id is not.

-- ------------------------------------------------------------------
-- 1. Server-owned execution context
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_contexts (
  id                BIGSERIAL PRIMARY KEY,

  -- Server-generated. Named by the capability token; never taken from input.
  context_id        VARCHAR(64) NOT NULL,

  -- Correlation root for this customer turn. Ties the context to trace_events.
  correlation_id    VARCHAR(64) NOT NULL,

  -- Trusted facts, established before the agent ran. AUTHORITATIVE.
  channel           VARCHAR(32)  NOT NULL,
  line_event_id     VARCHAR(255) NULL,
  identity_id       INTEGER      NULL,
  conversation_id   INTEGER      NOT NULL,
  project_id        INTEGER      NOT NULL,
  org_id            VARCHAR(64)  NOT NULL,

  -- The PromptX conversation slug this execution is allowed to act through.
  -- Lets the session-isolation check be verified locally instead of trusting
  -- a remote filter.
  promptx_slug      VARCHAR(255) NULL,

  status            VARCHAR(24)  NOT NULL DEFAULT 'active',
  expires_at        TIMESTAMPTZ  NOT NULL,
  consumed_at       TIMESTAMPTZ  NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_contexts_context_id
  ON execution_contexts (context_id);

CREATE INDEX IF NOT EXISTS idx_execution_contexts_conversation
  ON execution_contexts (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_contexts_correlation
  ON execution_contexts (correlation_id);

-- Expired contexts are swept, not reused.
CREATE INDEX IF NOT EXISTS idx_execution_contexts_expiry
  ON execution_contexts (expires_at)
  WHERE status = 'active';

COMMENT ON TABLE execution_contexts IS
  'Server-owned tenant authority for one customer turn. AgentX is never authoritative for org_id, project_id, identity_id or conversation_id; those are read from here.';

-- ------------------------------------------------------------------
-- 2. Causal trace
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trace_events (
  id                     BIGSERIAL PRIMARY KEY,

  correlation_id         VARCHAR(64)  NOT NULL,
  parent_correlation_id  VARCHAR(64)  NULL,

  component              VARCHAR(64)  NOT NULL,  -- line_webhook | promptx | agentx_gate | agentx_support | mcp | ticketx | outbox | plane | reverse_sync
  event_type             VARCHAR(64)  NOT NULL,
  status                 VARCHAR(24)  NOT NULL DEFAULT 'ok', -- ok | failed | skipped

  -- External execution identifiers. NULL when the component does not supply
  -- one; never invented.
  external_execution_id  VARCHAR(128) NULL,

  line_event_id          VARCHAR(255) NULL,
  conversation_id        INTEGER      NULL,
  identity_id            INTEGER      NULL,
  ticket_id              INTEGER      NULL,
  outbox_event_id        BIGINT       NULL,
  plane_issue_id         VARCHAR(128) NULL,
  project_id             INTEGER      NULL,
  org_id                 VARCHAR(64)  NULL,

  -- Small, non-sensitive summary only. Credentials must never be written here.
  detail                 JSONB        NULL,
  error_message          TEXT         NULL,

  occurred_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trace_events_correlation
  ON trace_events (correlation_id, id);

CREATE INDEX IF NOT EXISTS idx_trace_events_parent
  ON trace_events (parent_correlation_id)
  WHERE parent_correlation_id IS NOT NULL;

-- The query the gate requires: given a ticket, walk back to the LINE event.
CREATE INDEX IF NOT EXISTS idx_trace_events_ticket
  ON trace_events (ticket_id, id)
  WHERE ticket_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trace_events_line_event
  ON trace_events (line_event_id)
  WHERE line_event_id IS NOT NULL;

COMMENT ON TABLE trace_events IS
  'Append-only causal chain. A null external_execution_id means the component did not supply one - it is never fabricated.';

-- ------------------------------------------------------------------
-- 3. Bind a ticket to the execution that created it
-- ------------------------------------------------------------------
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS execution_context_id VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(64) NULL;

CREATE INDEX IF NOT EXISTS idx_tickets_correlation
  ON tickets (correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMENT ON COLUMN tickets.execution_context_id IS
  'The server-owned execution context whose tenant facts produced this ticket.';
