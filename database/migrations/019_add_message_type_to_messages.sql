-- Migration 019: Restore the messages.message_type column required by message persistence.
--
-- This is deliberately forward-only and idempotent. Some deployed databases
-- predate the rich-message migration while the backend already writes this
-- column for every inbound and outbound message.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS message_type VARCHAR(50) NOT NULL DEFAULT 'text';
