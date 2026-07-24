-- ============================================================================
-- AutomationX V3 Platform — Production Seed Data
-- ============================================================================

-- Insert Baseline Tenant Company
INSERT INTO companies (id, name, ai_profile_context) 
VALUES (1, 'AutomationX Enterprise', 'Primary corporate tenant environment')
ON CONFLICT (id) DO NOTHING;

-- Insert Default Project
INSERT INTO projects (id, company_id, name, project_type, environment)
VALUES (1, 1, 'TicketX Support Project', 'support', 'production')
ON CONFLICT (id) DO NOTHING;

-- Insert Baseline SLA Policies for Priority P1-P4
INSERT INTO project_sla_policies (project_id, priority, first_response_time_minutes, resolution_time_minutes)
VALUES 
(1, 'P1', 15, 120),
(1, 'P2', 60, 480),
(1, 'P3', 240, 1440),
(1, 'P4', 1440, 4320)
ON CONFLICT (project_id, priority) DO NOTHING;

-- Insert Baseline Business Hours (Monday to Friday, 09:00 - 18:00 Asia/Bangkok)
INSERT INTO project_business_hours (project_id, day_of_week, start_time, end_time, timezone)
VALUES 
(1, 1, '09:00:00', '18:00:00', 'Asia/Bangkok'),
(1, 2, '09:00:00', '18:00:00', 'Asia/Bangkok'),
(1, 3, '09:00:00', '18:00:00', 'Asia/Bangkok'),
(1, 4, '09:00:00', '18:00:00', 'Asia/Bangkok'),
(1, 5, '09:00:00', '18:00:00', 'Asia/Bangkok')
ON CONFLICT (project_id, day_of_week) DO NOTHING;

-- Insert Feature Flags
INSERT INTO project_feature_flags (project_id, flag_key, is_enabled)
VALUES 
(1, 'enable_rag', true),
(1, 'enable_auto_takeover', true),
(1, 'enable_plane_sync', false),
(1, 'enable_line_quote_reply', true)
ON CONFLICT (project_id, flag_key) DO NOTHING;

-- Record Baseline Schema Migrations Version
INSERT INTO schema_migrations (version) VALUES ('020_complete_message_runtime_schema.sql')
ON CONFLICT (version) DO NOTHING;
