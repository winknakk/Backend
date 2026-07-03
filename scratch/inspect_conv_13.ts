import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const res = await client.query("SELECT * FROM messages WHERE conversation_id = 12 ORDER BY id");
  console.log("Messages count for 12:", res.rows.length);
  if (res.rows.length > 0) {
    console.log("First message:", JSON.stringify(res.rows[0], null, 2));
    console.log("Last message:", JSON.stringify(res.rows[res.rows.length - 1], null, 2));
  }

  await client.end();
}

run();
