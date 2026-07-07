-- ============================================================
-- AutomationX V3 Test Fixtures Seed Data
-- seed_test.sql
-- ============================================================

TRUNCATE TABLE traces, tickets, messages, conversations, identities, profile_projects, profiles, project_prompts, project_sla_policies, project_channels, project_ai_settings, project_routing_rules, project_business_hours, project_holidays, project_mcp_permissions, project_feature_flags, projects, companies CASCADE;

-- Test tenant context
INSERT INTO companies (id, name) VALUES (1, 'Test Company') ON CONFLICT DO NOTHING;
INSERT INTO projects (id, company_id, name) VALUES (1, 1, 'Test Project') ON CONFLICT DO NOTHING;
INSERT INTO profiles (id, company_id, name) VALUES (1, 1, 'Test User') ON CONFLICT DO NOTHING;
INSERT INTO profile_projects (profile_id, project_id) VALUES (1, 1) ON CONFLICT DO NOTHING;
INSERT INTO identities (id, profile_id, channel, channel_ref) VALUES ('1', 1, 'LINE', 'LINE_USER_123456') ON CONFLICT DO NOTHING;

-- Configuration
INSERT INTO project_prompts (project_id, system_instruction, model_name, temperature, max_tokens)
VALUES (1, 'You are a test assistant.', 'gemini-1.5-pro', 0.00, 1024) ON CONFLICT DO NOTHING;

INSERT INTO project_sla_policies (project_id, priority, resolve_hours) VALUES
  (1, 'P1', 4),
  (1, 'P2', 24)
ON CONFLICT (project_id, priority) DO NOTHING;

INSERT INTO project_ai_settings (project_id, confidence_threshold, max_handoff_depth, vector_match_threshold)
VALUES (1, 0.70, 3, 0.60) ON CONFLICT (project_id) DO NOTHING;

INSERT INTO project_feature_flags (project_id, flag_name, is_enabled) VALUES
  (1, 'enable_auto_escalation', true),
  (1, 'enable_rag_search', true)
ON CONFLICT (project_id, flag_name) DO NOTHING;
