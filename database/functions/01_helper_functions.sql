-- ============================================================
-- TicketX / PromptX Platform — PostgreSQL Helper Functions
-- /database/functions/01_helper_functions.sql
-- Target Database: PostgreSQL 16+
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- UUID v7 Generator (Time-Ordered, Sortable, Distributed-Safe)
CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS UUID AS $$
DECLARE
  unix_ts_ms BYTEA;
  uuid_bytes BYTEA;
BEGIN
  unix_ts_ms := substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);
  uuid_bytes := uuid_send(gen_random_uuid());
  uuid_bytes := overlay(uuid_bytes placing unix_ts_ms from 1 for 6);
  uuid_bytes := set_bit(uuid_bytes, 52, 1);
  uuid_bytes := set_bit(uuid_bytes, 53, 1);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END $$ LANGUAGE plpgsql VOLATILE;

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Vector Search Knowledge Base Helper
CREATE OR REPLACE FUNCTION fn_search_knowledge_documents(
  p_project_id INT,
  p_embedding TEXT,
  p_match_threshold FLOAT,
  p_match_count INT
)
RETURNS TABLE (
  document_id UUID,
  title VARCHAR,
  content TEXT,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    kd.id AS document_id,
    kd.title,
    kd.raw_content AS content,
    1.0 AS similarity
  FROM knowledge_documents kd
  WHERE kd.project_id = p_project_id
    AND kd.is_active = TRUE
    AND kd.deleted_at IS NULL
  LIMIT p_match_count;
END;
$$ LANGUAGE plpgsql STABLE;
