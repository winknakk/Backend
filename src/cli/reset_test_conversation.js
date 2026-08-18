const { Client } = require('pg');
const dotenv = require('dotenv');
dotenv.config({ path: 'system/backend/.env' });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('--- Cleaning test conversation 1046 ---');
  // Mark old messages or close old conversation to allow a fresh start
  const resMsg = await client.query("DELETE FROM messages WHERE conversation_id = 1046;");
  console.log(`Deleted ${resMsg.rowCount} messages from conversation 1046`);

  const resConv = await client.query("UPDATE conversations SET status = 'closed' WHERE id = 1046;");
  console.log(`Closed conversation 1046 to force a fresh session on next message.`);

  await client.end();
}

run().catch(console.error);
