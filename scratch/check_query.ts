import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const conversationId = 12;

  // Test the subquery first
  const subRes = await client.query(
    "SELECT id FROM conversations WHERE identity_id = (SELECT identity_id FROM conversations WHERE id = $1::integer)",
    [conversationId]
  );
  console.log("Subquery IDs:", subRes.rows.map(r => r.id));

  // Test the main query
  const res = await client.query(
    `SELECT t.id, t.subject, t.summary, t.status, t.priority
     FROM tickets t
     WHERE t.conversation_id IN (
       SELECT id FROM conversations WHERE identity_id = (SELECT identity_id FROM conversations WHERE id = $1::integer)
     )`,
    [conversationId]
  );
  console.log("Main query rows count:", res.rows.length);
  if (res.rows.length > 0) {
    console.log("Main query rows:", res.rows);
  }

  // Test messages count query
  const msgsCountRes = await client.query(
    `SELECT COUNT(*)::integer AS count FROM messages
     WHERE conversation_id IN (
       SELECT id FROM conversations WHERE identity_id = (SELECT identity_id FROM conversations WHERE id = $1::integer)
     )`,
    [conversationId]
  );
  console.log("Messages count res rows:", msgsCountRes.rows);


  await client.end();
}

run();
