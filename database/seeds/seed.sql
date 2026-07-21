-- ============================================================
-- TicketX / PromptX Platform — Production Baseline Seed Data
-- /database/seeds/seed.sql
-- Target Database: PostgreSQL 16+
-- Simulation Scenario: Acme Corporation (Thailand) E-Commerce Platform
-- ============================================================

BEGIN;

-- 1. COMPANIES (Tenant Anchor)
INSERT INTO companies (id, name, slug, plan_tier, status, settings) VALUES
  (1, 'Acme Corporation Thailand', 'acme-thailand', 'enterprise', 'active', '{"default_locale": "th", "timezone": "Asia/Bangkok"}')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 2. TEAMS (Organizational Hierarchy)
INSERT INTO teams (id, company_id, name, description, status) VALUES
  (1, 1, 'Tier 1 Support Team', 'Frontline customer support handling LINE and WebChat', 'active'),
  (2, 1, 'Tier 2 Technical Engineering', 'Deep technical troubleshooting and bug investigation', 'active')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 3. PROJECTS (Workspaces)
INSERT INTO projects (id, company_id, team_id, name, slug, project_type, environment, status, timezone) VALUES
  (1, 1, 1, 'Acme E-Commerce Customer Support', 'acme-support', 'Support', 'production', 'active', 'Asia/Bangkok')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 4. OPERATORS (Human Agents & Managers)
INSERT INTO operators (id, company_id, primary_team_id, email, name, display_name, role, status, password_hash) VALUES
  (1, 1, 1, 'admin@acme.co.th', 'System Admin', 'Admin', 'super_admin', 'active', '$2b$10$EpN495/tXf41S.A7pX.12uJ/1w1Z1111111111111111111111111'),
  (2, 1, 1, 'napat@acme.co.th', 'Napat Jaidee', 'Agent Nop', 'agent', 'active', '$2b$10$EpN495/tXf41S.A7pX.12uJ/1w1Z1111111111111111111111111'),
  (3, 1, 2, 'somsak@acme.co.th', 'Somsak Tech', 'Eng Somsak', 'manager', 'active', '$2b$10$EpN495/tXf41S.A7pX.12uJ/1w1Z1111111111111111111111111')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 5. OPERATOR PROJECT ACCESS (RBAC Junction)
INSERT INTO operator_project_access (operator_id, project_id, role) VALUES
  (1, 1, 'manager'),
  (2, 1, 'agent'),
  (3, 1, 'manager')
ON CONFLICT (operator_id, project_id) DO NOTHING;

-- 6. PROFILES (Customers)
INSERT INTO profiles (id, company_id, name, display_name, email, phone, locale, timezone) VALUES
  (1, 1, 'Somchai Prasert', 'Somchai P.', 'somchai@gmail.com', '+66812345678', 'th', 'Asia/Bangkok'),
  (2, 1, 'Somsri Sukjai', 'Somsri S.', 'somsri@hotmail.com', '+66898765432', 'th', 'Asia/Bangkok')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 7. IDENTITIES (Channel References)
INSERT INTO identities (id, profile_id, channel, channel_ref, channel_name, account_type) VALUES
  (1, 1, 'line', 'U1029384756abcdef1029384756abcdef', 'Somchai LINE', 'individual'),
  (2, 2, 'webchat', 'wc-session-998877665544332211', 'Somsri WebGuest', 'individual')
ON CONFLICT (id) DO UPDATE SET channel_ref = EXCLUDED.channel_ref;

-- 8. CUSTOMER ENROLLMENTS (Profile ↔ Project Membership)
INSERT INTO customer_enrollments (id, profile_id, project_id, company_id, enrollment_source, enrollment_type, first_contact_at) VALUES
  (1, 1, 1, 1, 'first_contact', 'customer', NOW() - INTERVAL '2 days'),
  (2, 2, 1, 1, 'first_contact', 'vip', NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO UPDATE SET enrollment_type = EXCLUDED.enrollment_type;

-- 9. PROJECT CHANNELS (LINE & WebChat Config)
INSERT INTO project_channels (id, project_id, channel_type, channel_id, channel_name, active) VALUES
  (1, 1, 'line', '1657890123', 'Acme Thailand Official LINE', TRUE),
  (2, 1, 'webchat', 'wc-acme-prod-01', 'Acme WebChat Widget', TRUE)
ON CONFLICT (id) DO UPDATE SET channel_name = EXCLUDED.channel_name;

-- 10. PROJECT PROMPTS (AI System Prompt)
INSERT INTO project_prompts (id, project_id, prompt_text, version, version_label, is_active) VALUES
  (1, 1, 'คุณคือ PromptX AI ผู้ช่วยสนับสนุนลูกค้าภาษาไทยของ Acme Corporation ตอบคำถามด้วยความสุภาพ กระชับ และถูกต้องตามนโยบายบริษัท', 1, 'v1.0-production', TRUE)
ON CONFLICT (id) DO UPDATE SET prompt_text = EXCLUDED.prompt_text;

-- 11. PROJECT SLA POLICIES
INSERT INTO project_sla_policies (id, project_id, priority, response_hours, resolve_hours) VALUES
  (1, 1, 'P1', 0.50, 2.00),
  (2, 1, 'P2', 1.00, 4.00),
  (3, 1, 'P3', 2.00, 8.00),
  (4, 1, 'P4', 4.00, 24.00)
ON CONFLICT (id) DO UPDATE SET response_hours = EXCLUDED.response_hours;

-- 12. PROJECT AI SETTINGS
INSERT INTO project_ai_settings (id, project_id, auto_reply_enabled, confidence_threshold, model_name, temperature) VALUES
  (1, 1, TRUE, 0.75, 'gpt-4o', 0.20)
ON CONFLICT (id) DO UPDATE SET model_name = EXCLUDED.model_name;

-- 13. PROJECT BUSINESS HOURS (Mon-Fri 09:00-18:00)
INSERT INTO project_business_hours (project_id, day_of_week, start_time, end_time, is_working) VALUES
  (1, 1, '09:00:00', '18:00:00', TRUE),
  (1, 2, '09:00:00', '18:00:00', TRUE),
  (1, 3, '09:00:00', '18:00:00', TRUE),
  (1, 4, '09:00:00', '18:00:00', TRUE),
  (1, 5, '09:00:00', '18:00:00', TRUE),
  (1, 6, '09:00:00', '18:00:00', FALSE),
  (1, 0, '09:00:00', '18:00:00', FALSE)
ON CONFLICT (project_id, day_of_week) DO NOTHING;

-- 14. PROJECT HOLIDAYS
INSERT INTO project_holidays (id, project_id, holiday_date, name) VALUES
  (1, 1, '2026-04-13', 'Songkran Festival Day 1'),
  (2, 1, '2026-04-14', 'Songkran Festival Day 2'),
  (3, 1, '2026-05-01', 'National Labour Day')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 15. PROJECT FEATURE FLAGS
INSERT INTO project_feature_flags (id, project_id, flag_key, enabled) VALUES
  (1, 1, 'enable_auto_takeover_on_escalate', TRUE),
  (2, 1, 'enable_vector_rag_search', TRUE)
ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled;

-- 16. CONVERSATIONS
INSERT INTO conversations (id, identity_id, project_id, channel, conversation_type, status, handled_by, operator_id, takeover_state, last_message_at) VALUES
  (1, 1, 1, 'line', 'direct', 'open', 'human', 2, 'active', NOW() - INTERVAL '15 minutes'),
  (2, 2, 1, 'webchat', 'direct', 'open', 'ai', NULL, 'none', NOW() - INTERVAL '5 minutes')
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;

-- 17. TICKETS (Support Cases)
INSERT INTO tickets (id, ticket_id, conversation_id, project_id, operator_id, subject, status, priority, severity, issue_category, created_via) VALUES
  (1, 'TCK-2026-0001', 1, 1, 2, 'สอบถามการเปลี่ยนสินค้าชำรุดจากการจัดส่ง', 'In Progress', 'P2', 'High', 'product_exchange', 'AI'),
  (2, 'TCK-2026-0002', 2, 1, NULL, 'ไม่สามารถเข้าสู่ระบบเพื่อชำระเงินได้', 'Open', 'P3', 'Medium', 'login_issue', 'AI')
ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject;

-- 18. CONVERSATION TICKET LINKS (Junction)
INSERT INTO conversation_ticket_links (conversation_id, ticket_id, link_type, linked_by) VALUES
  (1, 1, 'primary', 'ai'),
  (2, 2, 'primary', 'ai')
ON CONFLICT (conversation_id, ticket_id) DO NOTHING;

-- 19. MESSAGES
INSERT INTO messages (id, conversation_id, project_id, ticket_id, role, sender_type, message_type, message_purpose, content) VALUES
  (1, 1, 1, 1, 'customer', 'customer', 'text', 'reply', 'สวัสดีครับ สินค้าที่สั่งมาส่งเมื่อเช้ากล่องบุบและสินค้าข้างในแตกครับ'),
  (2, 1, 1, 1, 'ai', 'ai', 'text', 'reply', 'สวัสดีค่ะคุณ Somchai ทาง Acme ขออภัยเป็นอย่างยิ่งนะคะ รบกวนส่งรูปถ่ายสินค้าที่ชำรุดเพื่อให้เจ้าหน้าที่ดำเนินการเปลี่ยนสินค้าชิ้นใหม่ให้ค่ะ'),
  (3, 1, 1, 1, 'customer', 'customer', 'image', 'reply', 'ส่งรูปถ่ายกล่องและสินค้าชำรุดเรียบร้อยครับ อยากขอคุยกับเจ้าหน้าที่ครับ'),
  (4, 1, 1, 1, 'human_operator', 'operator', 'text', 'reply', 'สวัสดีครับผม นภัทร รับช่วงดูแลต่อนะครับ กำลังออกใบสั่งเปลี่ยนสินค้าชิ้นใหม่ให้ทันทีครับ'),
  (5, 2, 1, 2, 'customer', 'customer', 'text', 'reply', 'กดปุ่มชำระเงินแล้วขึ้น Error Code 500 ค่ะ ต้องทำยังไงคะ')
ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content;

-- 20. MESSAGE ATTACHMENTS
INSERT INTO message_attachments (id, message_id, file_name, file_url, mime_type, storage_provider, attachment_type) VALUES
  (1, 3, 'damaged_item_01.jpg', 'https://storage.acme.co.th/uploads/damaged_item_01.jpg', 'image/jpeg', 's3', 'image')
ON CONFLICT (id) DO UPDATE SET file_url = EXCLUDED.file_url;

-- 21. TAKEOVER SESSIONS
INSERT INTO takeover_sessions (id, conversation_id, ticket_id, operator_id, project_id, status, acquired_at, expires_at, notes) VALUES
  (1, 1, 1, 2, 1, 'active', NOW() - INTERVAL '10 minutes', NOW() + INTERVAL '50 minutes', 'Customer requested human support for exchange process')
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;

-- 22. CONVERSATION HANDOFFS
INSERT INTO conversation_handoffs (id, conversation_id, project_id, ticket_id, from_owner, to_owner, to_operator_id, trigger_type, reason, started_at) VALUES
  (1, 1, 1, 1, 'ai', 'human', 2, 'customer_request', 'Customer explicitly requested to talk to a human agent', NOW() - INTERVAL '10 minutes')
ON CONFLICT (id) DO UPDATE SET trigger_type = EXCLUDED.trigger_type;

-- 23. INTERNAL NOTES
INSERT INTO internal_notes (id, conversation_id, ticket_id, operator_id, content, is_pinned) VALUES
  (1, 1, 1, 2, 'ตรวจสอบรูปถ่ายสินค้าแล้ว ชำรุดจริง อนุมัติเปลี่ยนสินค้าทดแทนแบบ Express Shipping', TRUE)
ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content;

-- 24. CONVERSATION PARTICIPANTS
INSERT INTO conversation_participants (id, conversation_id, project_id, participant_type, identity_id, operator_id, session_role, join_source) VALUES
  (1, 1, 1, 'customer', 1, NULL, 'reporter', 'direct'),
  (2, 1, 1, 'ai', NULL, NULL, 'ai_handler', 'system'),
  (3, 1, 1, 'operator', NULL, 2, 'owner', 'takeover')
ON CONFLICT (id) DO UPDATE SET session_role = EXCLUDED.session_role;

-- 25. KNOWLEDGE DOCUMENTS (RAG FAQs)
INSERT INTO knowledge_documents (id, project_id, company_id, title, raw_content, document_type, is_active) VALUES
  ('a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 1, 1, 'นโยบายการเปลี่ยนและคืนสินค้าชำรุด', 'ลูกค้าสามารถแจ้งเปลี่ยนสินค้าชำรุดได้ภายใน 7 วันทำการหลังได้รับสินค้า โดยแนบรูปถ่ายกล่องและสินค้าชำรุด บริษัทจะจัดส่งชิ้นใหม่ให้โดยไม่มีค่าใช้จ่ายเพิ่มเติม', 'policy', TRUE),
  ('b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e', 1, 1, 'วิธีแก้ไขปัญหาเข้าสู่ระบบชำระเงินไม่ได้', 'หากเกิด Error Code 500 ขณะชำระเงิน ให้ล้าง Cache ของเบราว์เซอร์ หรือสลับไปใช้แอปพลิเคชัน Acme Mobile บนสมาร์ทโฟน', 'faq', TRUE)
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title;

-- 26. KNOWLEDGE EMBEDDINGS
INSERT INTO knowledge_embeddings (id, document_id, project_id, model_name, embedding) VALUES
  (1, 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 1, 'text-embedding-3-small', '[vector_data_placeholder_01]'),
  (2, 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e', 1, 'text-embedding-3-small', '[vector_data_placeholder_02]')
ON CONFLICT (id) DO UPDATE SET model_name = EXCLUDED.model_name;

-- 27. AI MEMORY
INSERT INTO ai_memory (id, profile_id, project_id, memory_type, memory_scope, key, value, source_conv_id, source_ticket_id) VALUES
  (1, 1, 1, 'preference', 'customer', 'preferred_language', 'ไทย (สุภาพ)', 1, 1)
ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value;

-- 28. WEBHOOK EVENTS (Idempotent Ingestion Record)
INSERT INTO webhook_events (id, project_id, platform, channel_type, idempotency_key, raw_payload, status) VALUES
  ('c3d4e5f6-a7b8-9c0d-1e2f-3a4b5c6d7e8f', 1, 'line', 'line', 'line-evt-msg-id-889900112233', '{"events":[{"type":"message","message":{"type":"text","text":"สวัสดีครับ"}}]}', 'processed')
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;

-- 29. OUTBOX EVENTS (Transactional Event Log)
INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, project_id, payload, status) VALUES
  (1, 'support.ticket.created.v1', 'Ticket', '1', 1, '{"ticketId": 1, "ticketCode": "TCK-2026-0001", "subject": "สอบถามการเปลี่ยนสินค้าชำรุดจากการจัดส่ง"}', 'processed'),
  (2, 'support.takeover.acquired.v1', 'Ticket', '1', 1, '{"ticketId": 1, "operatorId": 2, "conversationId": 1}', 'pending')
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;

-- 30. TRACES (AI Tool Execution Trace)
INSERT INTO traces (id, trace_id, conversation_id, project_id, tool_name, arguments, result, status, latency_ms, cost_usd) VALUES
  (1, 'tr-88990011-2233', '1', 1, 'search_knowledge_documents', '{"query": "เปลี่ยนสินค้าชำรุด"}', '{"matched": 1, "document": "นโยบายการเปลี่ยนสินค้า"}', 'success', 245, 0.001200)
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;

COMMIT;
