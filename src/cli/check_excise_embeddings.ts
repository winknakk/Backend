import { pool } from "../adapters/postgres/PostgresAdapter";

async function checkEmbeddings() {
  let client;
  for (let i = 1; i <= 5; i++) {
    try {
      client = await pool.connect();
      break;
    } catch (e: any) {
      if (i === 5) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  const res = await client!.query(`
    SELECT doc_id, metadata->>'title' as title, metadata->>'category' as category, metadata->>'orgId' as org_id, metadata->>'projectId' as project_id
    FROM document_embeddings
    WHERE metadata->>'projectId' = '101' OR metadata->>'project_id' = '101'
    LIMIT 20;
  `);

  console.log("=== EMBEDDINGS FOR PROJECT 101 ===");
  console.table(res.rows);
  client!.release();
  await pool.end();
}

checkEmbeddings().catch(console.error);
