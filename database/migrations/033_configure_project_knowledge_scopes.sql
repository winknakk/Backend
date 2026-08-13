-- Configure database-driven PromptX Knowledge Base scopes.
-- The search_project_docs workflow reads this configuration after resolving
-- the authoritative Project from the active conversation.

UPDATE project_mcp_permissions
SET policy_rules =
  COALESCE(policy_rules, '{}'::jsonb)
  || jsonb_build_object(
    'knowledge_base',
    COALESCE(policy_rules->'knowledge_base', '{}'::jsonb)
    || jsonb_build_object('filter_tag', 'project_' || project_id::text)
  )
WHERE tool_name = 'search_project_docs'
  AND NULLIF(BTRIM(policy_rules #>> '{knowledge_base,filter_tag}'), '') IS NULL;

WITH known_scopes(project_id, filter_tag) AS (
  VALUES
    (1, 'AutomationX Demo'),
    (8, '24/7'),
    (101, 'Excise')
)
INSERT INTO project_mcp_permissions (
  project_id,
  tool_name,
  allowed_roles,
  policy_rules
)
SELECT
  scope.project_id,
  'search_project_docs',
  ARRAY['customer', 'agent']::VARCHAR(100)[],
  jsonb_build_object(
    'knowledge_base',
    jsonb_build_object('filter_tag', scope.filter_tag)
  )
FROM known_scopes scope
JOIN projects project ON project.id = scope.project_id
ON CONFLICT (project_id, tool_name) DO UPDATE
SET policy_rules =
  COALESCE(project_mcp_permissions.policy_rules, '{}'::jsonb)
  || jsonb_build_object(
    'knowledge_base',
    COALESCE(project_mcp_permissions.policy_rules->'knowledge_base', '{}'::jsonb)
    || EXCLUDED.policy_rules->'knowledge_base'
  );
