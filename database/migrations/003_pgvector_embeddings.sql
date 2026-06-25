-- ============================================================
-- AutomationX V2 - pgvector document embeddings
-- 003_pgvector_embeddings.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE traces ADD COLUMN IF NOT EXISTS agent_id VARCHAR(255);

CREATE TABLE IF NOT EXISTS document_embeddings (
  id SERIAL PRIMARY KEY,
  doc_id VARCHAR(255) UNIQUE NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_embeddings_doc_id ON document_embeddings(doc_id);
CREATE INDEX IF NOT EXISTS idx_document_embeddings_vector ON document_embeddings USING ivfflat (embedding vector_cosine_ops);
