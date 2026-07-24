import { pool } from "./adapters/postgres/PostgresAdapter";

async function check() {
  const { rows } = await pool.query(
    `SELECT id, conversation_id, role, content, quote_token, created_at FROM messages WHERE quote_token IS NOT NULL`
  );
  console.log("Found quote_token rows count:", rows.length);
  if (rows.length > 0) {
    console.log("Sample quote_token record:", JSON.stringify(rows[0], null, 2));
  }
  await pool.end();
}

check().catch(console.error);
