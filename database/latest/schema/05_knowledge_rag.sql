-- ============================================================
-- TicketX / PromptX Platform — Knowledge & Vector RAG Context Schema
-- /database/latest/schema/05_knowledge_rag.sql
-- Target Database: PostgreSQL 16+
-- ============================================================

-- 1. KNOWLEDGE DOCUMENTS (Aggregate Root)
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  external_doc_id   VARCHAR(255),
  title             VARCHAR(500) NOT NULL,
  raw_content       TEXT NOT NULL,
  processed_content TEXT,
  document_type     VARCHAR(50) NOT NULL DEFAULT 'knowledge' CHECK (document_type IN ('faq','manual','policy','procedure','ticket_resolution','conversation_summary','product_spec','legal','sop','other')),
  language          VARCHAR(20) NOT NULL DEFAULT 'th',
  source_url        TEXT,
  chunk_index       INTEGER NOT NULL DEFAULT 0,
  chunk_total       INTEGER NOT NULL DEFAULT 1,
  parent_doc_id     UUID REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL DEFAULT 1,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  indexed_at        TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_by        INTEGER REFERENCES operators(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ,
  UNIQUE (project_id, external_doc_id, chunk_index)
);

COMMENT ON TABLE knowledge_documents IS 'Knowledge RAG Context Aggregate Root — stores knowledge chunks and documents';

CREATE INDEX idx_know_docs_project_active ON knowledge_documents(project_id, is_active) WHERE is_active = TRUE AND deleted_at IS NULL;

-- 2. KNOWLEDGE EMBEDDINGS
CREATE TABLE IF NOT EXISTS knowledge_embeddings (
  id            SERIAL PRIMARY KEY,
  document_id   UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  model_name    VARCHAR(150) NOT NULL DEFAULT 'text-embedding-3-small',
  model_version VARCHAR(50),
  dimensions    INTEGER NOT NULL DEFAULT 1536,
  embedding     TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE knowledge_embeddings IS 'Vector embeddings associated with knowledge documents';

CREATE INDEX idx_know_embed_project ON knowledge_embeddings(project_id, model_name);

-- 3. DEPRECATED DOCUMENT EMBEDDINGS (Backward Compatibility)
CREATE TABLE IF NOT EXISTS document_embeddings (
  id         SERIAL PRIMARY KEY,
  doc_id     VARCHAR(255) NOT NULL UNIQUE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
