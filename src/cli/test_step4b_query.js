const { Client } = require('pg');
const dotenv = require('dotenv');
dotenv.config({ path: 'system/backend/.env' });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const query = "ระบบ EXC03 มีโมดูลอะไรบ้าง และไฟล์คอนฟิกหลักอยู่ที่ไหน";
  const projectId = "101";

  console.log('Testing step_4b query with full query:');
  const res1 = await client.query(
    "SELECT doc_id, content, metadata FROM document_embeddings WHERE (metadata->>'projectId' = $1 OR metadata->>'project_id' = $1) AND (content ILIKE '%' || $2 || '%' OR metadata->>'title' ILIKE '%' || $2 || '%' OR metadata->>'keywords'::text ILIKE '%' || $2 || '%') AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 5;",
    [projectId, query]
  );
  console.log('Result count with full query:', res1.rows.length);

  console.log('\nTesting with individual keywords:');
  for (const kw of ['EXC03', 'โมดูล', 'คอนฟิก', 'Jasper', 'Scheduler', 'ServiceImportFile']) {
    const res = await client.query(
      "SELECT doc_id, metadata->>'title' as title FROM document_embeddings WHERE (metadata->>'projectId' = $1 OR metadata->>'project_id' = $1) AND (content ILIKE '%' || $2 || '%' OR metadata->>'title' ILIKE '%' || $2 || '%') LIMIT 5;",
      [projectId, kw]
    );
    console.log(`Keyword "${kw}": found ${res.rows.length} rows`);
  }

  await client.end();
}

run().catch(console.error);
