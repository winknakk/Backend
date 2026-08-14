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
    SELECT doc_id, metadata
    FROM document_embeddings
    LIMIT 20;
  `);

  console.log("=== ALL DOCUMENT EMBEDDINGS ===");
  console.log(JSON.stringify(res.rows, null, 2));
  client!.release();
  await pool.end();
}

checkEmbeddings().catch(console.error);
