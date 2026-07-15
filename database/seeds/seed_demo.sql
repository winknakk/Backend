-- ============================================================
-- AutomationX V3 Demo Seed Data
-- seed_demo.sql
-- ============================================================

-- Clean existing data
TRUNCATE TABLE traces, tickets, messages, conversations, identities, profile_projects, profiles, project_prompts, project_sla_policies, project_channels, project_ai_settings, project_routing_rules, project_business_hours, project_holidays, project_mcp_permissions, project_feature_flags, projects, companies CASCADE;

-- 1. Companies & Projects
INSERT INTO companies (id, name) VALUES 
  (1, 'Demo Company'),
  (2, 'Retail Solutions Corp'),
  (5, 'Avalant Co.,Ltd.')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO projects (id, company_id, name, environment, project_type) VALUES 
  (1, 1, 'AutomationX Demo', 'AutomationX Demo Environment', 'Demo Project'),
  (2, 2, 'Customer Success Service', 'Customer Success Production', 'Support Project'),
  (999, 999, '24/7', 'Avalant 24/7 Production', 'Support Project'),
  (11, 5, 'SSO Project', 'SSO Production', 'Support Project'),
  (12, 5, 'CRA Project', 'CRA Production', 'Support Project')
ON CONFLICT (id) DO UPDATE SET 
  company_id = EXCLUDED.company_id, 
  name = EXCLUDED.name,
  environment = EXCLUDED.environment,
  project_type = EXCLUDED.project_type;

-- 2. Customer Profiles
INSERT INTO profiles (id, company_id, name) VALUES 
  (1, 1, 'John Doe'),
  (2, 2, 'Jane Smith'),
  (999, 999, 'Akkharin Laksana'),
  (11, 5, 'SSO Test Customer'),
  (12, 5, 'CRA Test Customer'),
  (10, 5, 'LINE Test User'),
  (67, 5, 'Natapohn Sawatsakulpattana')
ON CONFLICT (id) DO UPDATE SET company_id = EXCLUDED.company_id, name = EXCLUDED.name;

INSERT INTO profile_projects (profile_id, project_id) VALUES 
  (1, 1),
  (2, 2),
  (999, 999),
  (11, 11),
  (12, 12),
  (10, 1),
  (67, 999)
ON CONFLICT (profile_id, project_id) DO NOTHING;

-- 3. Identities (LINE and WhatsApp references)
INSERT INTO identities (id, profile_id, channel, channel_ref) VALUES 
  ('1', 1, 'line', 'U123456'),
  ('2', 2, 'whatsapp', 'W987654'),
  ('999', 999, 'line', 'Uad28c1eabbcbe1608e038d4d162f4944'),
  ('11', 11, 'line', 'U4be68575767f6b4a56e7d079f4c6d442'),
  ('12', 12, 'line', 'U60cacc31b2bb8a8ea8fb1779265edbc9'),
  ('13', 10, 'line', 'U6256f0c4dbb64edacf9eea92904e49b1'),
  ('67', 67, 'line', 'Ue3575daf4967d84d3a634bf55a06881c')
ON CONFLICT (id) DO UPDATE SET profile_id = EXCLUDED.profile_id, channel = EXCLUDED.channel, channel_ref = EXCLUDED.channel_ref;

-- 4. Conversations (various states)
INSERT INTO conversations (id, identity_id, project_id, channel, status, handled_by, assigned_pm) VALUES 
  (1, 1, 1, 'line', 'open', 'ai', NULL),
  (2, 2, 2, 'whatsapp', 'open', 'human', 'agent_alice'),
  (3, 1, 1, 'line', 'closed', 'ai', NULL),
  (999, 999, 999, 'line', 'open', 'ai', NULL),
  (11, 11, 11, 'line', 'open', 'ai', NULL),
  (12, 12, 12, 'line', 'open', 'ai', NULL),
  (67, 67, 999, 'line', 'open', 'ai', NULL)
ON CONFLICT (id) DO UPDATE SET identity_id = EXCLUDED.identity_id, project_id = EXCLUDED.project_id, channel = EXCLUDED.channel, status = EXCLUDED.status, handled_by = EXCLUDED.handled_by;

-- 5. Message History
INSERT INTO messages (id, conversation_id, role, content) VALUES
  (1, 1, 'customer', 'Cannot login Orbit App session expired'),
  (2, 1, 'ai', 'Please clear cache and restart your application.'),
  (3, 2, 'customer', 'I need billing support for invoice #1004'),
  (4, 2, 'ai', 'Billing support requires manual review. Redirecting...'),
  (5, 2, 'human', 'Hi Jane, this is Alice from billing. How can I help?'),
  (6, 3, 'customer', 'Hi there, how does the system work?'),
  (7, 3, 'ai', 'Our system automatically tracks issues and resolves tickets.'),
  (8, 999, 'customer', 'ระบบล่ม ขึ้น Error 404 Server เข้าไม่ได้เลย รีบด่วน'),
  (9, 11, 'customer', 'ขอความช่วยเหลือ เข้าใช้งานระบบ SSO ไม่ได้ครับ'),
  (10, 12, 'customer', 'สอบถามเรื่องสิทธิ์ใช้งานระบบ CRA หน่อยครับ')
ON CONFLICT (id) DO NOTHING;

-- 6. Support Tickets
INSERT INTO tickets (ticket_id, conversation_id, project_id, subject, summary, status, priority, created_via) VALUES 
  ('TCK-2026-00001', 1, 1, 'Orbit App Session Expired', 'Customer reported login loop on Orbit App.', 'Open', 'P2', 'ai'),
  ('TCK-2026-00002', 2, 2, 'Billing Invoice Issue', 'Customer requested refund or review of invoice #1004.', 'Open', 'P1', 'ai'),
  ('TCK-2026-00003', 3, 1, 'General System Inquiry', 'Customer asked about system operational flows.', 'Resolved', 'P4', 'ai')
ON CONFLICT DO NOTHING;

-- 7. Configuration Tables
INSERT INTO project_prompts (project_id, system_instruction, model_name, temperature, max_tokens) VALUES 
  (1, 'You are an helpful AI Assistant designed to resolve tickets and support customers.', 'gemini-1.5-pro', 0.00, 2048),
  (2, 'You are a sales support specialist. Direct billing requests to PMs.', 'gemini-1.5-flash', 0.50, 1024),
  (8, 'คุณคือ Support Agent AI สำหรับช่วยเหลือผู้ใช้ระบบ 24/7 ของ Avalant', 'gemini-1.5-pro', 0.00, 2048),
  (11, 'คุณคือ Support Agent AI สำหรับช่วยเหลือผู้ใช้ระบบ SSO/AD ของ กสม. (SSO Project)', 'gemini-1.5-pro', 0.00, 2048),
  (12, 'คุณคือ Support Agent AI สำหรับช่วยเหลือผู้ใช้ระบบ IT/CRA (CRA Project)', 'gemini-1.5-pro', 0.00, 2048)
ON CONFLICT DO NOTHING;

INSERT INTO project_sla_policies (project_id, priority, priority_name, description, response_hours, resolve_hours, service_window, is_default, display_order) VALUES
  -- Project 1 (Demo)
  (1, 'P1', 'Critical', 'System outage affecting all users', 1, 4, '24x7', false, 1),
  (1, 'P2', 'Severe', 'Major functionality unavailable', 4, 24, '24x7', false, 2),
  (1, 'P3', 'Major', 'Partial impact, business still operational', 8, 72, 'Business Hours', true, 3),
  (1, 'P4', 'Minor', 'Minimal impact', 24, 168, 'Business Hours', false, 4),
  
  -- Project 2
  (2, 'P1', 'Critical', 'System outage affecting all users', 1, 2, '24x7', false, 1),
  (2, 'P2', 'Severe', 'Major functionality unavailable', 2, 12, '24x7', false, 2),
  (2, 'P3', 'Major', 'Partial impact, business still operational', 8, 48, 'Business Hours', true, 3),
  (2, 'P4', 'Minor', 'Minimal impact', 24, 96, 'Business Hours', false, 4),
  
  -- Project 8
  (8, 'P1', 'Critical', 'System outage affecting all users', 1, 4, '24x7', false, 1),
  (8, 'P2', 'Severe', 'Major functionality unavailable', 4, 24, '24x7', false, 2),
  (8, 'P3', 'Major', 'Partial impact, business still operational', 8, 72, 'Business Hours', true, 3),
  (8, 'P4', 'Minor', 'Minimal impact', 24, 168, 'Business Hours', false, 4),
  
  -- SSO SLA (ระดับ 1 = P1 = 4h, ระดับ 2 = P2 = 8h, ระดับ 3 = P3 = 48h)
  (11, 'P1', 'Critical', 'ระบบ SSO ไม่สามารถใช้งานได้ทั้งหมด', 1, 4, '24x7', false, 1),
  (11, 'P2', 'Severe', 'บางส่วนไม่สามารถใช้งานได้ ซึ่งไม่กระทบกับระบบ', 2, 8, '24x7', false, 2),
  (11, 'P3', 'Major', 'คำแนะนำการใช้งานระบบ โดยระบบยังใช้งานได้ปกติ', 8, 48, 'Business Hours', true, 3),
  
  -- CRA SLA (P1 = 4h, P2 = 6h, P3 = 24h, P4 = 48h, P5 = 72h)
  (12, 'P1', 'Critical', 'ระบบ EW ทั้งหมดล่ม / ผู้ใช้ทุกคนได้รับผลกระทบ', 1, 4, '24x7', false, 1),
  (12, 'P2', 'Severe', 'EW บางส่วนล่ม / ผู้ใช้หลายหน่วยงานได้รับผลกระทบ', 4, 6, '24x7', false, 2),
  (12, 'P3', 'Major', 'EW บางส่วน / ผู้ใช้บางหน่วยงาน ยังดำเนินธุรกรรมได้', 8, 24, 'Business Hours', true, 3),
  (12, 'P4', 'Moderate', 'EW บางส่วน / กระทบน้อย ยังดำเนินธุรกรรมได้ปกติ', 12, 48, 'Business Hours', false, 4),
  (12, 'P5', 'Minor', 'กระทบระบบเดียว / กระทบน้อย ไม่เร่งด่วน', 24, 72, 'Business Hours', false, 5)
ON CONFLICT (project_id, priority) DO NOTHING;

INSERT INTO project_ai_settings (project_id, confidence_threshold, max_handoff_depth, vector_match_threshold) VALUES 
  (1, 0.70, 5, 0.60),
  (2, 0.85, 3, 0.70),
  (8, 0.70, 5, 0.60),
  (11, 0.70, 5, 0.60),
  (12, 0.70, 5, 0.60)
ON CONFLICT (project_id) DO NOTHING;

INSERT INTO project_feature_flags (project_id, flag_name, is_enabled) VALUES
  (1, 'enable_auto_escalation', true),
  (1, 'enable_rag_search', true),
  (2, 'enable_auto_escalation', false),
  (2, 'enable_rag_search', false),
  (8, 'enable_auto_escalation', true),
  (8, 'enable_rag_search', true),
  (11, 'enable_auto_escalation', true),
  (11, 'enable_rag_search', true),
  (12, 'enable_auto_escalation', true),
  (12, 'enable_rag_search', true)
ON CONFLICT (project_id, flag_name) DO NOTHING;

INSERT INTO project_channels (project_id, channel_type, channel_id, secret_token, active) VALUES 
  (1, 'LINE', 'channel-123', 'secret-token-abc', true),
  (2, 'whatsapp', 'channel-456', 'secret-token-def', true),
  (11, 'LINE', 'channel-sso', 'secret-token-sso', true),
  (12, 'LINE', 'channel-cra', 'secret-token-cra', true)
ON CONFLICT DO NOTHING;

INSERT INTO project_routing_rules (project_id, rule_type, conditions, target_handler) VALUES 
  (1, 'intent', '{"contains": "billing"}', 'billing_handler'),
  (2, 'escalation', '{"sentiment": "negative"}', 'escalation_handler')
ON CONFLICT DO NOTHING;

INSERT INTO project_mcp_permissions (project_id, tool_name, allowed_roles, policy_rules) VALUES
  -- Project 1 (Demo)
  (1, 'create_ticket', ARRAY['customer', 'agent'], '{}'),
  (1, 'search_project_docs', ARRAY['customer', 'agent'], '{}'),
  (1, 'get_ticket_status', ARRAY['customer', 'agent'], '{}'),
  (1, 'find_ticket', ARRAY['customer', 'agent'], '{}'),
  (1, 'merge_ticket', ARRAY['agent'], '{}'),
  (1, 'close_ticket', ARRAY['agent'], '{}'),
  (1, 'assign_ticket', ARRAY['agent'], '{}'),
  (1, 'update_summary', ARRAY['agent'], '{}'),
  (1, 'escalate_to_pm', ARRAY['agent'], '{}'),
  -- Project 2
  (2, 'create_ticket', ARRAY['agent'], '{}'),
  (2, 'get_ticket_status', ARRAY['customer', 'agent'], '{}'),
  (2, 'find_ticket', ARRAY['customer', 'agent'], '{}'),
  (2, 'close_ticket', ARRAY['agent'], '{}'),
  (2, 'assign_ticket', ARRAY['agent'], '{}'),
  (2, 'escalate_to_pm', ARRAY['agent'], '{}'),
  -- Project 8 (Avalant 24/7)
  (8, 'create_ticket', ARRAY['customer', 'agent'], '{}'),
  (8, 'search_project_docs', ARRAY['customer', 'agent'], '{}'),
  (8, 'get_ticket_status', ARRAY['customer', 'agent'], '{}'),
  (8, 'find_ticket', ARRAY['customer', 'agent'], '{}'),
  (8, 'merge_ticket', ARRAY['agent'], '{}'),
  (8, 'close_ticket', ARRAY['agent'], '{}'),
  (8, 'assign_ticket', ARRAY['agent'], '{}'),
  (8, 'update_summary', ARRAY['agent'], '{}'),
  (8, 'escalate_to_pm', ARRAY['agent'], '{}'),
  -- Project 11 (SSO)
  (11, 'create_ticket', ARRAY['customer', 'agent'], '{}'),
  (11, 'search_project_docs', ARRAY['customer', 'agent'], '{}'),
  (11, 'get_ticket_status', ARRAY['customer', 'agent'], '{}'),
  (11, 'find_ticket', ARRAY['customer', 'agent'], '{}'),
  (11, 'close_ticket', ARRAY['agent'], '{}'),
  (11, 'assign_ticket', ARRAY['agent'], '{}'),
  (11, 'escalate_to_pm', ARRAY['agent'], '{}'),
  -- Project 12 (CRA)
  (12, 'create_ticket', ARRAY['customer', 'agent'], '{}'),
  (12, 'search_project_docs', ARRAY['customer', 'agent'], '{}'),
  (12, 'get_ticket_status', ARRAY['customer', 'agent'], '{}'),
  (12, 'find_ticket', ARRAY['customer', 'agent'], '{}'),
  (12, 'close_ticket', ARRAY['agent'], '{}'),
  (12, 'assign_ticket', ARRAY['agent'], '{}'),
  (12, 'escalate_to_pm', ARRAY['agent'], '{}')
ON CONFLICT (project_id, tool_name) DO NOTHING;
