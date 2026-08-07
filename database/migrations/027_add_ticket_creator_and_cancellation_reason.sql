-- Migration 027: Add Ticket Creator Attribution, Cancellation Reason, and Identity Verification
-- Date: 2026-08-07

-- 1. Add Creator Attribution and Cancellation Reason fields to tickets table
ALTER TABLE tickets 
ADD COLUMN IF NOT EXISTS created_by_type VARCHAR(30) DEFAULT 'CUSTOMER',
ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- Add CHECK constraint for created_by_type idempotently
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_tickets_created_by_type'
    ) THEN
        ALTER TABLE tickets 
        ADD CONSTRAINT chk_tickets_created_by_type 
        CHECK (created_by_type IN ('CUSTOMER', 'HUMAN_AGENT', 'AI_BOT', 'PLANE_IO'));
    END IF;
END $$;

-- Index for filtering tickets by creator type
CREATE INDEX IF NOT EXISTS idx_tickets_created_by_type ON tickets(created_by_type);

-- 2. Add Identity Verification fields to identities table
ALTER TABLE identities
ADD COLUMN IF NOT EXISTS verification_status VARCHAR(50) DEFAULT 'UNVERIFIED_GUEST',
ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;

-- Add CHECK constraint for verification_status idempotently
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_identities_verification_status'
    ) THEN
        ALTER TABLE identities 
        ADD CONSTRAINT chk_identities_verification_status 
        CHECK (verification_status IN ('UNVERIFIED_GUEST', 'VERIFIED_CUSTOMER'));
    END IF;
END $$;

-- Index for filtering unverified identities
CREATE INDEX IF NOT EXISTS idx_identities_verification_status ON identities(verification_status);

-- 3. Update existing tickets with default creator types based on plane_issue_id
UPDATE tickets 
SET created_by_type = 'PLANE_IO' 
WHERE plane_issue_id IS NOT NULL AND (created_by_type IS NULL OR created_by_type = 'CUSTOMER');
