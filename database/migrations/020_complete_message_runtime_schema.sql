-- Migration 020: Complete the message schema required by the active backend.
--
-- The deployed database has the historical core message tables, but it is
-- missing columns referenced by PostgresAdapter.saveMessage(), the admin
-- conversation timeline, and the media attachment repository. Keep this
-- migration forward-only and idempotent so it is safe on newer databases too.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id INTEGER NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.messages'::regclass
      AND conname = 'messages_reply_to_message_id_fkey'
  ) THEN
    ALTER TABLE public.messages
      ADD CONSTRAINT messages_reply_to_message_id_fkey
      FOREIGN KEY (reply_to_message_id)
      REFERENCES public.messages(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_messages_reply_to_message_id
  ON public.messages (reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

DO $$
BEGIN
  CREATE TYPE attachment_status AS ENUM (
    'UPLOADING',
    'PROCESSING',
    'READY',
    'FAILED',
    'DELETED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE public.message_attachments
  ADD COLUMN IF NOT EXISTS storage_key VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS thumbnail_url VARCHAR(2048) NULL,
  ADD COLUMN IF NOT EXISTS attachment_status attachment_status NOT NULL DEFAULT 'READY',
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id
  ON public.message_attachments (message_id);

CREATE INDEX IF NOT EXISTS idx_message_attachments_storage_key
  ON public.message_attachments (storage_key)
  WHERE storage_key IS NOT NULL;
