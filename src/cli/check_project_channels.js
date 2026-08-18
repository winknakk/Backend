const { Client } = require('pg');
const dotenv = require('dotenv');
dotenv.config({ path: 'system/backend/.env' });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('--- Checking project_channels ---');
  const pc = await client.query("SELECT id, project_id, channel_type, channel_id, is_enabled, active FROM project_channels;");
  console.table(pc.rows);

  console.log('--- Checking identities ---');
  const iden = await client.query("SELECT id, profile_id, channel, channel_ref FROM identities LIMIT 20;");
  console.table(iden.rows);

  await client.end();
}

run().catch(console.error);
