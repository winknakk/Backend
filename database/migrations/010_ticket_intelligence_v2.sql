-- Up Migration: Enhanced Ticket Intelligence

-- 1. Re-align tickets table primary key to use SERIAL integer ID
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_pkey CASCADE;

-- Rename old string id to ticket_id
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tickets' AND column_name = 'id' AND data_type = 'character varying') THEN
    ALTER TABLE tickets RENAME COLUMN id TO ticket_id;
    ALTER TABLE tickets ADD COLUMN id SERIAL PRIMARY KEY;
  END IF;
END $$;

-- Ensure ticket_id has a UNIQUE constraint and is NOT NULL
ALTER TABLE tickets ALTER COLUMN ticket_id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_ticket_id_key') THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_ticket_id_key UNIQUE (ticket_id);
  END IF;
END $$;

-- 2. Add Ticket Intelligence columns
ALTER TABLE tickets 
ADD COLUMN IF NOT EXISTS severity VARCHAR(50),
ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS title VARCHAR(255),
ADD COLUMN IF NOT EXISTS original_problem_statement TEXT,
ADD COLUMN IF NOT EXISTS running_summary TEXT,
ADD COLUMN IF NOT EXISTS last_ai_summary TEXT,
ADD COLUMN IF NOT EXISTS duplicate_of_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS duplicate_score NUMERIC(3, 2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS duplicate_reason TEXT,
ADD COLUMN IF NOT EXISTS ai_confidence_metrics JSONB DEFAULT '{"title": 0.00, "summary": 0.00, "duplicate": 0.00}'::jsonb,
ADD COLUMN IF NOT EXISTS searchable_text TSVECTOR;

-- Create GIN index for search optimization
CREATE INDEX IF NOT EXISTS tickets_searchable_text_idx ON tickets USING gin(searchable_text);

-- 3. Create the ticket_events table
CREATE TABLE IF NOT EXISTS ticket_events (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  event_type VARCHAR(100) NOT NULL,
  actor VARCHAR(50) NOT NULL,
  source VARCHAR(50) NOT NULL,
  correlation_id VARCHAR(100),
  payload JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS ticket_events_ticket_id_idx ON ticket_events(ticket_id, created_at ASC);

-- 4. Create ticket_embeddings table conditionally
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    CREATE TABLE IF NOT EXISTS ticket_embeddings (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER UNIQUE NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      embedding VECTOR(1536) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_embeddings_vector ON ticket_embeddings USING ivfflat (embedding vector_cosine_ops);
  ELSE
    CREATE TABLE IF NOT EXISTS ticket_embeddings (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER UNIQUE NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      embedding TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  END IF;
END $$;
