import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const convs = await client.query("SELECT id, identity_id FROM conversations ORDER BY id");
  console.log("Conversation IDs in database:", convs.rows.map(r => `${r.id} (ident: ${r.identity_id})`));

  const msgs = await client.query("SELECT DISTINCT conversation_id FROM messages ORDER BY conversation_id");
  console.log("Conversation IDs in messages:", msgs.rows.map(r => r.conversation_id));

  const tix = await client.query("SELECT DISTINCT conversation_id FROM tickets ORDER BY conversation_id");
  console.log("Conversation IDs in tickets:", tix.rows.map(r => r.conversation_id));

  await client.end();
}

run();
