-- ============================================================
-- AutomationX V3 Development Seed Data
-- seed_dev.sql
-- ============================================================

-- Clean existing data
TRUNCATE TABLE traces, tickets, messages, conversations, identities, profile_projects, profiles, project_prompts, project_sla_policies, project_channels, project_ai_settings, project_routing_rules, project_business_hours, project_holidays, project_mcp_permissions, project_feature_flags, projects, companies CASCADE;

-- 1. Core Corporate Structure
INSERT INTO companies (id, name) VALUES (1, 'Demo Company') ON CONFLICT DO NOTHING;
INSERT INTO projects (id, company_id, name) VALUES (1, 1, 'AutomationX Demo') ON CONFLICT DO NOTHING;

-- 2. Customer Profiles & Identities
INSERT INTO profiles (id, company_id, name) VALUES (1, 1, 'John Doe') ON CONFLICT DO NOTHING;
INSERT INTO profile_projects (profile_id, project_id) VALUES (1, 1) ON CONFLICT DO NOTHING;
INSERT INTO identities (id, profile_id, channel, channel_ref) VALUES ('1', 1, 'LINE', 'U123456') ON CONFLICT DO NOTHING;

-- 3. Conversations (AI-driven session)
INSERT INTO conversations (id, identity_id, project_id, channel, status, handled_by) 
VALUES (1, 1, 1, 'LINE', 'open', 'ai') ON CONFLICT DO NOTHING;

-- 4. Message logs
INSERT INTO messages (id, conversation_id, role, content) VALUES
  (1, 1, 'customer', 'Cannot login Orbit App session expired'),
  (2, 1, 'ai', 'Please clear cache and restart your application.')
ON CONFLICT DO NOTHING;

-- 5. Open Ticket
INSERT INTO tickets (ticket_id, conversation_id, project_id, subject, summary, status, priority, created_via)
VALUES ('TCK-2026-00001', 1, 1, 'Orbit App Session Expired', 'Customer reported login loop on Orbit App.', 'Open', 'P2', 'ai') ON CONFLICT DO NOTHING;

-- 6. Project Configuration Tables
INSERT INTO project_prompts (project_id, system_instruction, model_name, temperature, max_tokens)
VALUES (1, 'You are an helpful AI Assistant designed to resolve tickets and support customers.', 'gemini-1.5-pro', 0.00, 2048) ON CONFLICT DO NOTHING;

INSERT INTO project_sla_policies (project_id, priority, resolve_hours) VALUES
  (1, 'P1', 4),
  (1, 'P2', 24),
  (1, 'P3', 72),
  (1, 'P4', 168)
ON CONFLICT (project_id, priority) DO NOTHING;

INSERT INTO project_ai_settings (project_id, confidence_threshold, max_handoff_depth, vector_match_threshold)
VALUES (1, 0.70, 5, 0.60) ON CONFLICT (project_id) DO NOTHING;

INSERT INTO project_feature_flags (project_id, flag_name, is_enabled) VALUES
  (1, 'enable_auto_escalation', true),
  (1, 'enable_rag_search', true)
ON CONFLICT (project_id, flag_name) DO NOTHING;

INSERT INTO project_channels (project_id, channel_type, channel_id, secret_token, active)
VALUES (1, 'LINE', 'channel-123', 'secret-token-abc', true) ON CONFLICT DO NOTHING;

INSERT INTO project_routing_rules (project_id, rule_type, conditions, target_handler)
VALUES (1, 'intent', '{"contains": "billing"}', 'billing_handler') ON CONFLICT DO NOTHING;

INSERT INTO project_mcp_permissions (project_id, tool_name, allowed_roles, policy_rules) VALUES
  (1, 'create_ticket', ARRAY['customer', 'agent'], '{}'),
  (1, 'search_project_docs', ARRAY['customer', 'agent'], '{}')
ON CONFLICT (project_id, tool_name) DO NOTHING;
