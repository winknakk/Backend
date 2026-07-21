-- ============================================================
-- TicketX / PromptX Platform — Row Level Security Policies
-- /database/latest/policies/01_rls_tenant_isolation.sql
-- Target Database: PostgreSQL 16+
-- ============================================================

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_channels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_conversations_tenant_isolation ON conversations;
CREATE POLICY p_conversations_tenant_isolation ON conversations
  FOR ALL
  USING (
    project_id = NULLIF(current_setting('app.current_project_id', TRUE), '')::INT
    OR current_setting('app.current_project_id', TRUE) IS NULL
  );

DROP POLICY IF EXISTS p_messages_tenant_isolation ON messages;
CREATE POLICY p_messages_tenant_isolation ON messages
  FOR ALL
  USING (
    project_id = NULLIF(current_setting('app.current_project_id', TRUE), '')::INT
    OR current_setting('app.current_project_id', TRUE) IS NULL
  );

DROP POLICY IF EXISTS p_tickets_tenant_isolation ON tickets;
CREATE POLICY p_tickets_tenant_isolation ON tickets
  FOR ALL
  USING (
    project_id = NULLIF(current_setting('app.current_project_id', TRUE), '')::INT
    OR current_setting('app.current_project_id', TRUE) IS NULL
  );

DROP POLICY IF EXISTS p_knowledge_docs_tenant_isolation ON knowledge_documents;
CREATE POLICY p_knowledge_docs_tenant_isolation ON knowledge_documents
  FOR ALL
  USING (
    project_id = NULLIF(current_setting('app.current_project_id', TRUE), '')::INT
    OR current_setting('app.current_project_id', TRUE) IS NULL
  );

DROP POLICY IF EXISTS p_project_channels_tenant_isolation ON project_channels;
CREATE POLICY p_project_channels_tenant_isolation ON project_channels
  FOR ALL
  USING (
    project_id = NULLIF(current_setting('app.current_project_id', TRUE), '')::INT
    OR current_setting('app.current_project_id', TRUE) IS NULL
  );
