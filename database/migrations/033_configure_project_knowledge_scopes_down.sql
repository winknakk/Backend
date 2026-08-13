-- Remove only the Knowledge Base filter tag introduced by migration 033.
-- Permission rows are preserved because they may predate this migration.

UPDATE project_mcp_permissions
SET policy_rules = CASE
  WHEN COALESCE(policy_rules->'knowledge_base', '{}'::jsonb) - 'filter_tag' = '{}'::jsonb
    THEN COALESCE(policy_rules, '{}'::jsonb) - 'knowledge_base'
  ELSE jsonb_set(
    COALESCE(policy_rules, '{}'::jsonb),
    '{knowledge_base}',
    COALESCE(policy_rules->'knowledge_base', '{}'::jsonb) - 'filter_tag',
    true
  )
END
WHERE tool_name = 'search_project_docs'
  AND (
    policy_rules #>> '{knowledge_base,filter_tag}' IN ('AutomationX Demo', '24/7', 'Excise')
    OR policy_rules #>> '{knowledge_base,filter_tag}' = 'project_' || project_id::text
  );
