-- ============================================================
-- AutomationX V3 Mock Executions Seed Data
-- seed_mock.sql
-- ============================================================

TRUNCATE TABLE traces, tickets, messages, conversations, identities, profile_projects, profiles, project_prompts, project_sla_policies, project_channels, project_ai_settings, project_routing_rules, project_business_hours, project_holidays, project_mcp_permissions, project_feature_flags, projects, companies CASCADE;

-- Mock environment setup
INSERT INTO companies (id, name) VALUES (99, 'Mock Corp') ON CONFLICT DO NOTHING;
INSERT INTO projects (id, company_id, name) VALUES (99, 99, 'Mock Project Workspace') ON CONFLICT DO NOTHING;
INSERT INTO profiles (id, company_id, name) VALUES (99, 99, 'Mock Client') ON CONFLICT DO NOTHING;
INSERT INTO profile_projects (profile_id, project_id) VALUES (99, 99) ON CONFLICT DO NOTHING;
INSERT INTO identities (id, profile_id, channel, channel_ref) VALUES ('99', 99, 'mock', 'mock-sender-uuid') ON CONFLICT DO NOTHING;

-- Configuration
INSERT INTO project_prompts (project_id, system_instruction, model_name, temperature, max_tokens)
VALUES (99, 'You are a mock agent.', 'gemini-1.5-pro', 0.00, 512) ON CONFLICT DO NOTHING;

INSERT INTO project_sla_policies (project_id, priority, resolve_hours) VALUES
  (99, 'P1', 1),
  (99, 'P2', 12)
ON CONFLICT (project_id, priority) DO NOTHING;

INSERT INTO project_ai_settings (project_id, confidence_threshold, max_handoff_depth, vector_match_threshold)
VALUES (99, 0.50, 5, 0.50) ON CONFLICT (project_id) DO NOTHING;

-- Mock traces (simulating previous executions)
INSERT INTO traces (id, trace_id, session_id, agent_id, tool_name, called_at, reason, arguments, result, status) VALUES
  (1, 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 'mock-session-1', 'mock_agent', 'create_ticket', NOW() - INTERVAL '10 minutes', 'Create support ticket for client login', '{"subject": "Mock Ticket"}', '{"ticketId": "TCK-MOCK-001"}', 'COMPLETED'),
  (2, 'f6e5d4c3-b2a1-0f9e-8d7c-6b5a4f3e2d1c', 'mock-session-1', 'mock_agent', 'search_project_docs', NOW() - INTERVAL '8 minutes', 'Search for user login doc match', '{"query": "expired"}', '{"results": ["Clearing cache resolves login session expiry."]}', 'COMPLETED')
ON CONFLICT DO NOTHING;
