-- LINE first-contact project onboarding.
-- Project join codes are stored only as HMAC-SHA256 digests. Plaintext codes
-- are returned once by the backend when an administrator rotates a code.

CREATE TABLE IF NOT EXISTS project_join_codes (
  id BIGSERIAL PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL DEFAULT 'org_default' REFERENCES organizations(id),
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code_digest CHAR(64) NOT NULL UNIQUE,
  code_hint VARCHAR(4) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at TIMESTAMPTZ,
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  last_used_at TIMESTAMPTZ,
  created_by VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_join_codes_one_active
  ON project_join_codes (org_id, project_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_project_join_codes_lookup
  ON project_join_codes (org_id, code_digest)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS line_onboarding_sessions (
  org_id VARCHAR(64) NOT NULL DEFAULT 'org_default' REFERENCES organizations(id),
  line_user_id VARCHAR(255) NOT NULL,
  destination VARCHAR(255) NOT NULL,
  state VARCHAR(32) NOT NULL DEFAULT 'AWAITING_CHOICE'
    CHECK (state IN (
      'AWAITING_CHOICE',
      'AWAITING_CODE',
      'AWAITING_PROJECT_DETAILS',
      'PENDING_HUMAN',
      'COMPLETED'
    )),
  selected_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, line_user_id, destination)
);

CREATE INDEX IF NOT EXISTS idx_line_onboarding_sessions_state
  ON line_onboarding_sessions (org_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS line_onboarding_requests (
  id BIGSERIAL PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL DEFAULT 'org_default' REFERENCES organizations(id),
  line_user_id VARCHAR(255) NOT NULL,
  destination VARCHAR(255) NOT NULL,
  requested_details TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved', 'rejected')),
  resolved_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_line_onboarding_requests_pending
  ON line_onboarding_requests (org_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS line_webhook_events (
  webhook_event_id VARCHAR(128) PRIMARY KEY,
  line_user_id VARCHAR(255),
  event_type VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'processed', 'failed')),
  response JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_line_webhook_events_received_at
  ON line_webhook_events (received_at DESC);

