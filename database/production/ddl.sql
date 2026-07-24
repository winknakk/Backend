-- ============================================================================
-- AutomationX V3 Platform — Master DDL (Table Definitions, Functions & Triggers)
-- Target Database: PostgreSQL 16+
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Helper Functions & Triggers
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_timestamp_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ language 'plpgsql';

-- ----------------------------------------------------------------------------
-- 2. Domain Subsystem 1: Tenant, Customer, Identity & Organization
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS companies (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    ai_profile_context TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    project_type VARCHAR(50) DEFAULT 'support',
    environment VARCHAR(50) DEFAULT 'production',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS teams (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
    parent_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS profiles (
    id VARCHAR(255) PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(50),
    gdpr_consent BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS identities (
    id SERIAL PRIMARY KEY,
    profile_id VARCHAR(255) REFERENCES profiles(id) ON DELETE CASCADE,
    channel VARCHAR(50) NOT NULL,
    channel_ref VARCHAR(255) NOT NULL,
    is_shared BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_identities_channel_ref UNIQUE (channel, channel_ref)
);

CREATE TABLE IF NOT EXISTS profile_projects (
    profile_id VARCHAR(255) REFERENCES profiles(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (profile_id, project_id)
);

CREATE TABLE IF NOT EXISTS customer_enrollments (
    id SERIAL PRIMARY KEY,
    profile_id VARCHAR(255) REFERENCES profiles(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    customer_type VARCHAR(50) DEFAULT 'standard',
    enrolment_source VARCHAR(100) DEFAULT 'web',
    is_active BOOLEAN DEFAULT true,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_customer_enrollment UNIQUE (profile_id, project_id)
);

CREATE TABLE IF NOT EXISTS operators (
    id VARCHAR(255) PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'agent',
    is_active BOOLEAN DEFAULT true,
    last_login_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS operator_project_access (
    operator_id VARCHAR(255) REFERENCES operators(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    access_level VARCHAR(50) NOT NULL DEFAULT 'agent',
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (operator_id, project_id)
);

-- ----------------------------------------------------------------------------
-- 3. Domain Subsystem 2: Conversations, Messaging, Takeover & WebChat
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    identity_id INTEGER REFERENCES identities(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    promptx_conversation_id VARCHAR(255),
    channel VARCHAR(50) NOT NULL,
    status VARCHAR(50) DEFAULT 'open',
    handled_by VARCHAR(50) DEFAULT 'ai',
    assigned_pm VARCHAR(255),
    operator_id VARCHAR(255) REFERENCES operators(id) ON DELETE SET NULL,
    takeover_state VARCHAR(50) DEFAULT 'none',
    last_message_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_participants (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    participant_type VARCHAR(50) NOT NULL,
    participant_id VARCHAR(255) NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    ticket_id INTEGER,
    reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    role VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    message_type VARCHAR(50) DEFAULT 'text',
    quote_token TEXT,
    external_id VARCHAR(255),
    delivery_status VARCHAR(50) DEFAULT 'sent',
    reactions JSONB DEFAULT '{}'::jsonb,
    is_pinned BOOLEAN DEFAULT false,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_messages_external_id UNIQUE (conversation_id, external_id)
);

CREATE TABLE IF NOT EXISTS message_attachments (
    id SERIAL PRIMARY KEY,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    file_url TEXT NOT NULL,
    thumbnail_url TEXT,
    file_name VARCHAR(255) NOT NULL,
    file_type VARCHAR(100) NOT NULL,
    file_size INTEGER NOT NULL,
    storage_key VARCHAR(512),
    attachment_status VARCHAR(50) DEFAULT 'ready',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webchat_sessions (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    identity_id INTEGER REFERENCES identities(id) ON DELETE CASCADE,
    session_token TEXT UNIQUE NOT NULL,
    guest_uuid VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    last_active_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS takeover_sessions (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    operator_id VARCHAR(255) REFERENCES operators(id) ON DELETE SET NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE_HUMAN',
    reason TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    released_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS conversation_handoffs (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    from_handler VARCHAR(50) NOT NULL,
    to_handler VARCHAR(50) NOT NULL,
    reason_code VARCHAR(100),
    reason_detail TEXT,
    context_snapshot JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS internal_notes (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    ticket_id INTEGER,
    operator_id VARCHAR(255) REFERENCES operators(id) ON DELETE SET NULL,
    note_text TEXT NOT NULL,
    is_pinned BOOLEAN DEFAULT false,
    mentions JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_events (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    actor_type VARCHAR(50) NOT NULL,
    actor_id VARCHAR(255),
    payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 4. Domain Subsystem 3: Ticket Intelligence & Workflow Integration
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tickets (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    ticket_number VARCHAR(100) UNIQUE,
    subject VARCHAR(255) NOT NULL,
    summary TEXT,
    status VARCHAR(50) DEFAULT 'open',
    priority VARCHAR(50) DEFAULT 'medium',
    severity VARCHAR(50) DEFAULT 'low',
    assigned_pm VARCHAR(255),
    created_via VARCHAR(50) DEFAULT 'ai',
    plane_issue_id VARCHAR(255),
    enrichment_state JSONB DEFAULT '{}'::jsonb,
    due_date TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_ticket_links (
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    link_type VARCHAR(50) DEFAULT 'primary',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (conversation_id, ticket_id)
);

-- Circular FK link from messages -> tickets
ALTER TABLE messages ADD CONSTRAINT fk_messages_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL;
ALTER TABLE internal_notes ADD CONSTRAINT fk_internal_notes_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS ticket_events (
    id SERIAL PRIMARY KEY,
    ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    actor VARCHAR(255) NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb,
    correlation_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_embeddings (
    ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    embedding vector(1536),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outbox_events (
    id SERIAL PRIMARY KEY,
    aggregate_type VARCHAR(100) NOT NULL,
    aggregate_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 5. Domain Subsystem 4: Project Config, SLA & Tool Policies
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS project_prompts (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE UNIQUE,
    system_prompt TEXT NOT NULL,
    model_name VARCHAR(100) DEFAULT 'gpt-4o',
    temperature NUMERIC DEFAULT 0.2,
    max_tokens INTEGER DEFAULT 2000,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_ai_settings (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE UNIQUE,
    confidence_threshold NUMERIC DEFAULT 0.75,
    max_handoff_depth INTEGER DEFAULT 3,
    vector_match_limit INTEGER DEFAULT 5,
    allow_tools BOOLEAN DEFAULT true,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_sla_policies (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    priority VARCHAR(50) NOT NULL,
    first_response_time_minutes INTEGER NOT NULL,
    resolution_time_minutes INTEGER NOT NULL,
    is_active BOOLEAN DEFAULT true,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_project_sla_priority UNIQUE (project_id, priority)
);

CREATE TABLE IF NOT EXISTS project_business_hours (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    timezone VARCHAR(100) DEFAULT 'Asia/Bangkok',
    CONSTRAINT uq_project_day UNIQUE (project_id, day_of_week)
);

CREATE TABLE IF NOT EXISTS project_holidays (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    holiday_date DATE NOT NULL,
    description VARCHAR(255),
    CONSTRAINT uq_project_holiday_date UNIQUE (project_id, holiday_date)
);

CREATE TABLE IF NOT EXISTS company_holiday_calendars (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
    calendar_name VARCHAR(255) NOT NULL,
    country_code VARCHAR(10) DEFAULT 'TH',
    is_default BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS company_holidays (
    id SERIAL PRIMARY KEY,
    calendar_id INTEGER REFERENCES company_holiday_calendars(id) ON DELETE CASCADE,
    holiday_date DATE NOT NULL,
    name VARCHAR(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS project_channels (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    channel_type VARCHAR(50) NOT NULL,
    is_enabled BOOLEAN DEFAULT true,
    config_metadata JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_project_channel UNIQUE (project_id, channel_type)
);

CREATE TABLE IF NOT EXISTS project_routing_rules (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    rule_name VARCHAR(255) NOT NULL,
    condition_json JSONB NOT NULL,
    target_handler VARCHAR(100) NOT NULL,
    priority INTEGER DEFAULT 1,
    is_active BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS project_mcp_permissions (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    tool_name VARCHAR(100) NOT NULL,
    is_allowed BOOLEAN DEFAULT true,
    policy_rules JSONB DEFAULT '{}'::jsonb,
    CONSTRAINT uq_project_mcp_tool UNIQUE (project_id, tool_name)
);

CREATE TABLE IF NOT EXISTS project_feature_flags (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    flag_key VARCHAR(100) NOT NULL,
    is_enabled BOOLEAN DEFAULT false,
    config JSONB DEFAULT '{}'::jsonb,
    CONSTRAINT uq_project_flag UNIQUE (project_id, flag_key)
);

-- ----------------------------------------------------------------------------
-- 6. Domain Subsystem 5: Knowledge, Memory & Operations
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS knowledge_documents (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    category VARCHAR(100) DEFAULT 'general',
    is_active BOOLEAN DEFAULT true,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_embeddings (
    id SERIAL PRIMARY KEY,
    document_id INTEGER REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    chunk_content TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    embedding vector(1536),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_embeddings (
    id SERIAL PRIMARY KEY,
    doc_id VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    embedding vector(1536),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_memory (
    id SERIAL PRIMARY KEY,
    profile_id VARCHAR(255) REFERENCES profiles(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    memory_type VARCHAR(50) NOT NULL,
    key VARCHAR(100) NOT NULL,
    value TEXT NOT NULL,
    confidence NUMERIC DEFAULT 1.0,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_events (
    id SERIAL PRIMARY KEY,
    channel VARCHAR(50) NOT NULL,
    event_id VARCHAR(255) UNIQUE NOT NULL,
    payload JSONB NOT NULL,
    processed_status VARCHAR(50) DEFAULT 'received',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS traces (
    id SERIAL PRIMARY KEY,
    trace_id UUID NOT NULL,
    session_id VARCHAR(255),
    agent_id VARCHAR(100),
    tool_name VARCHAR(100),
    called_at TIMESTAMPTZ DEFAULT NOW(),
    reason TEXT,
    arguments JSONB,
    result JSONB,
    status VARCHAR(50) DEFAULT 'success',
    error_message TEXT,
    completed_at TIMESTAMPTZ,
    request_id VARCHAR(255),
    conversation_id VARCHAR(255),
    parent_trace_id VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id SERIAL PRIMARY KEY,
    entity_type VARCHAR(100) NOT NULL,
    entity_id VARCHAR(255) NOT NULL,
    action VARCHAR(50) NOT NULL,
    changes JSONB DEFAULT '{}'::jsonb,
    actor VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS on_call_rosters (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    operator_id VARCHAR(255) REFERENCES operators(id) ON DELETE CASCADE,
    shift_start TIMESTAMPTZ NOT NULL,
    shift_end TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_logs (
    id SERIAL PRIMARY KEY,
    ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    operator_id VARCHAR(255) REFERENCES operators(id) ON DELETE SET NULL,
    channel VARCHAR(50) NOT NULL,
    recipient_ref VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'SENT',
    ack_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS verification_requests (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    profile_id VARCHAR(255) REFERENCES profiles(id) ON DELETE CASCADE,
    strategy VARCHAR(50) NOT NULL,
    target_ref VARCHAR(255) NOT NULL,
    otp_code_hash VARCHAR(255),
    invitation_token VARCHAR(255) UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    is_used BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
