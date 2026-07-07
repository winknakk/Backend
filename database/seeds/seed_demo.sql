-- ============================================================
-- AutomationX V3 Demo Seed Data
-- seed_demo.sql
-- ============================================================

-- Clean existing data
TRUNCATE TABLE traces, tickets, messages, conversations, identities, profile_projects, profiles, project_prompts, project_sla_policies, project_channels, project_ai_settings, project_routing_rules, project_business_hours, project_holidays, project_mcp_permissions, project_feature_flags, projects, companies CASCADE;

-- 1. Companies & Projects
INSERT INTO companies (id, name) VALUES 
  (1, 'Demo Company'),
  (2, 'Retail Solutions Corp')
ON CONFLICT DO NOTHING;

INSERT INTO projects (id, company_id, name) VALUES 
  (1, 1, 'AutomationX Demo'),
  (2, 2, 'Customer Success Service')
ON CONFLICT DO NOTHING;

-- 2. Customer Profiles
INSERT INTO profiles (id, company_id, name) VALUES 
  (1, 1, 'John Doe'),
  (2, 2, 'Jane Smith')
ON CONFLICT DO NOTHING;

INSERT INTO profile_projects (profile_id, project_id) VALUES 
  (1, 1),
  (2, 2)
ON CONFLICT DO NOTHING;

-- 3. Identities (LINE and WhatsApp references)
INSERT INTO identities (id, profile_id, channel, channel_ref) VALUES 
  ('1', 1, 'LINE', 'U123456'),
  ('2', 2, 'whatsapp', 'W987654')
ON CONFLICT DO NOTHING;

-- 4. Conversations (various states)
INSERT INTO conversations (id, identity_id, project_id, channel, status, handled_by, assigned_pm) VALUES 
  (1, 1, 1, 'LINE', 'open', 'ai', NULL),
  (2, 2, 2, 'whatsapp', 'open', 'human', 'agent_alice'),
  (3, 1, 1, 'LINE', 'closed', 'ai', NULL)
ON CONFLICT DO NOTHING;

-- 5. Message History
INSERT INTO messages (id, conversation_id, role, content) VALUES
  (1, 1, 'customer', 'Cannot login Orbit App session expired'),
  (2, 1, 'ai', 'Please clear cache and restart your application.'),
  (3, 2, 'customer', 'I need billing support for invoice #1004'),
  (4, 2, 'ai', 'Billing support requires manual review. Redirecting...'),
  (5, 2, 'human', 'Hi Jane, this is Alice from billing. How can I help?'),
  (6, 3, 'customer', 'Hi there, how does the system work?'),
  (7, 3, 'ai', 'Our system automatically tracks issues and resolves tickets.')
ON CONFLICT DO NOTHING;

-- 6. Support Tickets
INSERT INTO tickets (id, conversation_id, project_id, subject, summary, status, priority, created_via) VALUES 
  ('TCK-2026-00001', 1, 1, 'Orbit App Session Expired', 'Customer reported login loop on Orbit App.', 'Open', 'P2', 'ai'),
  ('TCK-2026-00002', 2, 2, 'Billing Invoice Issue', 'Customer requested refund or review of invoice #1004.', 'Open', 'P1', 'ai'),
  ('TCK-2026-00003', 3, 1, 'General System Inquiry', 'Customer asked about system operational flows.', 'Resolved', 'P4', 'ai')
ON CONFLICT DO NOTHING;

-- 7. Configuration Tables
INSERT INTO project_prompts (project_id, system_instruction, model_name, temperature, max_tokens) VALUES 
  (1, 'You are an helpful AI Assistant designed to resolve tickets and support customers.', 'gemini-1.5-pro', 0.00, 2048),
  (2, 'You are a sales support specialist. Direct billing requests to PMs.', 'gemini-1.5-flash', 0.50, 1024)
ON CONFLICT DO NOTHING;

INSERT INTO project_sla_policies (project_id, priority, resolve_hours) VALUES
  (1, 'P1', 4),
  (1, 'P2', 24),
  (1, 'P3', 72),
  (1, 'P4', 168),
  (2, 'P1', 2),
  (2, 'P2', 12),
  (2, 'P3', 48),
  (2, 'P4', 96)
ON CONFLICT (project_id, priority) DO NOTHING;

INSERT INTO project_ai_settings (project_id, confidence_threshold, max_handoff_depth, vector_match_threshold) VALUES 
  (1, 0.70, 5, 0.60),
  (2, 0.85, 3, 0.70)
ON CONFLICT (project_id) DO NOTHING;

INSERT INTO project_feature_flags (project_id, flag_name, is_enabled) VALUES
  (1, 'enable_auto_escalation', true),
  (1, 'enable_rag_search', true),
  (2, 'enable_auto_escalation', false),
  (2, 'enable_rag_search', false)
ON CONFLICT (project_id, flag_name) DO NOTHING;

INSERT INTO project_channels (project_id, channel_type, channel_id, secret_token, active) VALUES 
  (1, 'LINE', 'channel-123', 'secret-token-abc', true),
  (2, 'whatsapp', 'channel-456', 'secret-token-def', true)
ON CONFLICT DO NOTHING;

INSERT INTO project_routing_rules (project_id, rule_type, conditions, target_handler) VALUES 
  (1, 'intent', '{"contains": "billing"}', 'billing_handler'),
  (2, 'escalation', '{"sentiment": "negative"}', 'escalation_handler')
ON CONFLICT DO NOTHING;

INSERT INTO project_mcp_permissions (project_id, tool_name, allowed_roles, policy_rules) VALUES
  (1, 'create_ticket', ARRAY['customer', 'agent'], '{}'),
  (1, 'search_project_docs', ARRAY['customer', 'agent'], '{}'),
  (2, 'create_ticket', ARRAY['agent'], '{}')
ON CONFLICT (project_id, tool_name) DO NOTHING;
