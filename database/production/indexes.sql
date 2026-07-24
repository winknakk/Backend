-- ============================================================================
-- AutomationX V3 Platform — Production Indexes
-- Target Database: PostgreSQL 16+ (pgvector HNSW / B-tree / GIN)
-- ============================================================================

-- Primary & Foreign Key Indexing
CREATE INDEX IF NOT EXISTS idx_projects_company_id ON projects(company_id);
CREATE INDEX IF NOT EXISTS idx_teams_company_id ON teams(company_id);
CREATE INDEX IF NOT EXISTS idx_profiles_company_id ON profiles(company_id);
CREATE INDEX IF NOT EXISTS idx_identities_profile_id ON identities(profile_id);
CREATE INDEX IF NOT EXISTS idx_identities_channel_ref ON identities(channel, channel_ref);
CREATE INDEX IF NOT EXISTS idx_operators_company_id ON operators(company_id);
CREATE INDEX IF NOT EXISTS idx_operators_email ON operators(email);

-- Conversation & Messaging Hot Path Indexing
CREATE INDEX IF NOT EXISTS idx_conversations_identity_id ON conversations(identity_id);
CREATE INDEX IF NOT EXISTS idx_conversations_project_id ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_handled_by ON conversations(handled_by);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations(last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_external_id ON messages(external_id);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);

CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id ON message_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_webchat_sessions_guest ON webchat_sessions(guest_uuid);
CREATE INDEX IF NOT EXISTS idx_webchat_sessions_token ON webchat_sessions(session_token);

CREATE INDEX IF NOT EXISTS idx_takeover_sessions_conv ON takeover_sessions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_takeover_sessions_operator ON takeover_sessions(operator_id);
CREATE INDEX IF NOT EXISTS idx_internal_notes_conv ON internal_notes(conversation_id);

-- Ticket Intelligence & SLA Indexing
CREATE INDEX IF NOT EXISTS idx_tickets_conversation_id ON tickets(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tickets_project_id ON tickets(project_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
CREATE INDEX IF NOT EXISTS idx_tickets_due_date ON tickets(due_date ASC);
CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_id ON ticket_events(ticket_id);
CREATE INDEX IF NOT EXISTS idx_outbox_events_status ON outbox_events(status, created_at ASC);

-- Vector Search Indexing (HNSW with Cosine Distance)
CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_hnsw 
ON knowledge_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_ticket_embeddings_hnsw 
ON ticket_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_document_embeddings_hnsw 
ON document_embeddings USING hnsw (embedding vector_cosine_ops);

-- Traces & Observability Indexing
CREATE INDEX IF NOT EXISTS idx_traces_trace_id ON traces(trace_id);
CREATE INDEX IF NOT EXISTS idx_traces_conversation_id ON traces(conversation_id);
CREATE INDEX IF NOT EXISTS idx_traces_called_at ON traces(called_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_event_id ON webhook_events(event_id);
