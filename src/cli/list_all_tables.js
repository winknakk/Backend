const { Client } = require('pg');
const dotenv = require('dotenv');
dotenv.config({ path: 'system/backend/.env' });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('=== Tables in Database ===');
  const tables = await client.query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('public', 'cs_tickets') ORDER BY table_name;");
  console.table(tables.rows);

  console.log('=== All 5 EXC03 Documents in document_embeddings ===');
  const docs = await client.query("SELECT doc_id, metadata->>'title' as title FROM document_embeddings;");
  console.table(docs.rows);

  await client.end();
}

run().catch(console.error);
