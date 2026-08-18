const { Client } = require('pg');
const dotenv = require('dotenv');
dotenv.config({ path: 'system/backend/.env' });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('--- Checking schema ---');
  const schema = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'project_mcp_permissions';");
  console.table(schema.rows);

  const tools = [
    'create_ticket',
    'get_ticket_status',
    'find_ticket',
    'merge_ticket',
    'close_ticket',
    'assign_ticket',
    'update_summary',
    'escalate_to_pm',
    'reopen_ticket'
  ];

  console.log('--- Granting tool permissions for Project 101 ---');
  for (const t of tools) {
    await client.query(
      "DELETE FROM project_mcp_permissions WHERE project_id = 101 AND tool_name = $1",
      [t]
    );
    await client.query(
      "INSERT INTO project_mcp_permissions (project_id, tool_name, policy_rules) VALUES (101, $1, '{}'::jsonb)",
      [t]
    );
  }

  const perms = await client.query("SELECT project_id, tool_name, policy_rules FROM project_mcp_permissions WHERE project_id = 101;");
  console.table(perms.rows);

  await client.end();
}

run().catch(console.error);
