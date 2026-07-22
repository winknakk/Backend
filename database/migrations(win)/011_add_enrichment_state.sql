-- Up Migration: Add enrichment_state to tickets
ALTER TABLE tickets 
ADD COLUMN IF NOT EXISTS enrichment_state VARCHAR(50) DEFAULT 'PENDING' NOT NULL;
