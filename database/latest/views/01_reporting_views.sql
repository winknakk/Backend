-- ============================================================
-- TicketX / PromptX Platform — Reporting Database Views
-- /database/latest/views/01_reporting_views.sql
-- Target Database: PostgreSQL 16+
-- ============================================================

CREATE OR REPLACE VIEW v_active_inbox AS
SELECT
  c.id AS conversation_id,
  c.project_id,
  c.channel,
  c.status AS conversation_status,
  c.handled_by,
  c.takeover_state,
  c.operator_id,
  op.name AS operator_name,
  i.channel_ref,
  p.id AS profile_id,
  p.name AS customer_name,
  p.email AS customer_email,
  t.id AS ticket_id,
  t.ticket_id AS ticket_code,
  t.status AS ticket_status,
  t.priority AS ticket_priority,
  c.last_message_at,
  c.created_at AS conversation_created_at
FROM conversations c
LEFT JOIN operators op ON op.id = c.operator_id
LEFT JOIN identities i ON i.id = c.identity_id
LEFT JOIN profiles p ON p.id = i.profile_id
LEFT JOIN conversation_ticket_links ctl ON ctl.conversation_id = c.id AND ctl.link_type = 'primary'
LEFT JOIN tickets t ON t.id = ctl.ticket_id
WHERE c.deleted_at IS NULL
  AND c.status IN ('open','pending','escalated');

CREATE OR REPLACE VIEW v_ticket_sla_status AS
SELECT
  t.id AS ticket_id,
  t.ticket_id AS ticket_code,
  t.project_id,
  t.subject,
  t.status,
  t.priority,
  t.operator_id,
  op.name AS operator_name,
  t.created_at,
  t.due_date,
  t.sla_response_due_at,
  t.sla_resolve_due_at,
  t.sla_breached,
  CASE
    WHEN t.status IN ('Resolved','Closed','Cancelled') THEN 'COMPLETED'
    WHEN NOW() > t.sla_resolve_due_at THEN 'RESOLVE_BREACHED'
    WHEN NOW() > t.sla_response_due_at AND t.first_response_at IS NULL THEN 'RESPONSE_BREACHED'
    ELSE 'WITHIN_SLA'
  END AS sla_state
FROM tickets t
LEFT JOIN operators op ON op.id = t.operator_id
WHERE t.deleted_at IS NULL;

CREATE OR REPLACE VIEW v_ai_cost_analytics AS
SELECT
  tr.project_id,
  p.name AS project_name,
  DATE_TRUNC('day', tr.called_at) AS log_date,
  tr.model_name,
  COUNT(tr.id) AS total_calls,
  SUM(COALESCE(tr.input_tokens, 0)) AS total_input_tokens,
  SUM(COALESCE(tr.output_tokens, 0)) AS total_output_tokens,
  SUM(COALESCE(tr.cost_usd, 0.00)) AS total_cost_usd,
  AVG(tr.latency_ms) AS avg_latency_ms
FROM traces tr
LEFT JOIN projects p ON p.id = tr.project_id
GROUP BY tr.project_id, p.name, DATE_TRUNC('day', tr.called_at), tr.model_name;
