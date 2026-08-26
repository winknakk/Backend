-- ============================================================
-- Migration 041: Customer notification ledger
-- ============================================================
--
-- The Golden Flow sends the customer three kinds of message:
--   acknowledgement          "we have your report, we are looking at it"
--   ticket_created           "case #TCK-XXXX has been opened"
--   resolution_confirmation  "please check and confirm"
--
-- Every one of them must be sent at most once. LINE retries webhooks, the
-- reverse-sync poller re-reads the same Plane state every cycle, and an
-- operator can resolve a ticket twice. Without a ledger each of those becomes
-- a duplicate message to a real customer.
--
-- The existing notification_logs table cannot serve this: it is ticket-scoped
-- (so it cannot record an acknowledgement that precedes the ticket), has no
-- notification type, and has no uniqueness constraint to deduplicate on.
--
-- Idempotency is enforced by the database, not by application checks, because
-- the two paths that send these run concurrently.

CREATE TABLE IF NOT EXISTS customer_notifications (
  id                BIGSERIAL PRIMARY KEY,
  conversation_id   INTEGER NOT NULL,
  ticket_id         INTEGER NULL,
  project_id        INTEGER NULL,
  org_id            VARCHAR(64) NULL,

  -- acknowledgement | ticket_created | resolution_confirmation | closed | reopened
  notification_type VARCHAR(48) NOT NULL,

  -- Deterministic per logical event. For an acknowledgement this is the LINE
  -- webhookEventId, so a retried webhook collides instead of re-sending.
  idempotency_key   VARCHAR(255) NOT NULL,

  channel           VARCHAR(32) NOT NULL DEFAULT 'line',
  recipient_ref     VARCHAR(255) NULL,

  -- pending -> sent | failed | suppressed
  status            VARCHAR(24) NOT NULL DEFAULT 'pending',
  body              TEXT NULL,
  error_message     TEXT NULL,
  correlation_id    VARCHAR(128) NULL,

  sent_at           TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The constraint that actually prevents duplicates. A second attempt to send
-- the same notification for the same logical event violates this and is
-- reported as "already sent" rather than delivered twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_notifications_idempotency
  ON customer_notifications (notification_type, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_customer_notifications_conversation
  ON customer_notifications (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_notifications_ticket
  ON customer_notifications (ticket_id)
  WHERE ticket_id IS NOT NULL;

COMMENT ON TABLE customer_notifications IS
  'Ledger of customer-facing messages. The unique index on (notification_type, idempotency_key) is what guarantees at-most-once delivery.';
