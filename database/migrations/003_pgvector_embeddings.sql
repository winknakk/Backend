-- ============================================================
-- AutomationX V2 - pgvector document embeddings (Conditional)
-- 003_pgvector_embeddings.sql
-- ============================================================

-- Try to create the vector extension if it's available
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
  END IF;
END
$$;

-- Always alter traces table
ALTER TABLE traces ADD COLUMN IF NOT EXISTS agent_id VARCHAR(255);

-- Create table based on whether vector type exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    -- If pgvector is installed, create table with VECTOR type
    CREATE TABLE IF NOT EXISTS document_embeddings (
      id SERIAL PRIMARY KEY,
      doc_id VARCHAR(255) UNIQUE NOT NULL,
      content TEXT NOT NULL,
      metadata JSONB DEFAULT '{}',
      embedding VECTOR(1536) NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    
    -- Create indexes
    CREATE INDEX IF NOT EXISTS idx_document_embeddings_doc_id ON document_embeddings(doc_id);
    CREATE INDEX IF NOT EXISTS idx_document_embeddings_vector ON document_embeddings USING ivfflat (embedding vector_cosine_ops);
  ELSE
    -- If pgvector is NOT installed, create a fallback table (with embedding as TEXT)
    CREATE TABLE IF NOT EXISTS document_embeddings (
      id SERIAL PRIMARY KEY,
      doc_id VARCHAR(255) UNIQUE NOT NULL,
      content TEXT NOT NULL,
      metadata JSONB DEFAULT '{}',
      embedding TEXT, -- fallback
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_document_embeddings_doc_id ON document_embeddings(doc_id);
  END IF;
END
$$;

