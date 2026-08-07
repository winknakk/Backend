-- Migration 027 Rollback: Drop Ticket Creator Attribution, Cancellation Reason, and Identity Verification fields
-- Date: 2026-08-07

-- 1. Drop constraints and indexes on tickets table
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS chk_tickets_created_by_type;
DROP INDEX IF EXISTS idx_tickets_created_by_type;

-- Drop columns on tickets table
ALTER TABLE tickets 
DROP COLUMN IF EXISTS created_by_type,
DROP COLUMN IF EXISTS created_by_name,
DROP COLUMN IF EXISTS cancellation_reason;

-- 2. Drop constraints and indexes on identities table
ALTER TABLE identities DROP CONSTRAINT IF EXISTS chk_identities_verification_status;
DROP INDEX IF EXISTS idx_identities_verification_status;

-- Drop columns on identities table
ALTER TABLE identities
DROP COLUMN IF EXISTS verification_status,
DROP COLUMN IF EXISTS is_verified;
