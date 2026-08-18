const { Client } = require('pg');
const dotenv = require('dotenv');
dotenv.config({ path: 'system/backend/.env' });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('=== 1. All Documents in Knowledge Base (Project 101) ===');
  const docs = await client.query("SELECT doc_id, metadata->>'title' as title, substring(content, 1, 200) as preview FROM document_embeddings WHERE metadata->>'projectId' = '101' OR metadata->>'project_id' = '101';");
  console.table(docs.rows);

  console.log('=== 2. Handoffs / Escalations ===');
  const handoffs = await client.query("SELECT id, conversation_id, reason_code, status, created_at FROM handoffs ORDER BY id DESC LIMIT 5;");
  console.table(handoffs.rows);

  console.log('=== 3. Search for MFR4048 across entire DB ===');
  const mfrDocs = await client.query("SELECT * FROM document_embeddings WHERE content ILIKE '%MFR4048%' OR metadata::text ILIKE '%MFR4048%';");
  console.log('MFR4048 in document_embeddings:', mfrDocs.rows.length);

  await client.end();
}

run().catch(console.error);
