import { pool } from "../adapters/postgres/PostgresAdapter";

async function debugConv(): Promise<void> {
  const client = await pool.connect();
  try {
    const cRes = await client.query(`SELECT c.*, p.name as project_name, p.org_id as project_org_id FROM conversations c JOIN projects p ON p.id = c.project_id WHERE c.id = 1041`);
    console.log("=== Conversation 1041 Detail ===");
    console.log(JSON.stringify(cRes.rows, null, 2));

    const pRes = await client.query(`SELECT * FROM projects WHERE id = 101`);
    console.log("=== Project 101 Detail ===");
    console.log(JSON.stringify(pRes.rows, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

debugConv().catch(console.error);
