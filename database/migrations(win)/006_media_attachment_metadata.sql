-- Migration: 006_media_attachment_metadata.sql
-- Description: Extends message_attachments table to support Object Storage keys, thumbnails, JSONB metadata, and processing state machine.

-- 1. Ensure message_type exists on messages table
ALTER TABLE public.messages 
ADD COLUMN IF NOT EXISTS message_type varchar(50) DEFAULT 'text' NOT NULL;

-- 2. Create attachment status ENUM
DO $$ BEGIN
    CREATE TYPE attachment_status AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED', 'DELETED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 3. Extend message_attachments table with storage, thumbnail, status, and metadata
ALTER TABLE public.message_attachments 
ADD COLUMN IF NOT EXISTS storage_key varchar(500) NULL,
ADD COLUMN IF NOT EXISTS thumbnail_url varchar(2048) NULL,
ADD COLUMN IF NOT EXISTS attachment_status attachment_status DEFAULT 'READY' NOT NULL,
ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb NOT NULL;

-- 4. Add performance index on message_id for attachment lookups
CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id 
ON public.message_attachments USING btree (message_id);

-- 5. Add index on storage_key for fast direct key lookups
CREATE INDEX IF NOT EXISTS idx_message_attachments_storage_key 
ON public.message_attachments USING btree (storage_key);
