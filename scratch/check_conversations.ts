import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const res = await client.query("SELECT * FROM conversations");
  console.log("Conversations details:");
  res.rows.forEach(r => {
    console.log(`ID: ${r.id}, channel: ${r.channel}, status: ${r.status}, identity_id: ${r.identity_id}`);
  });

  await client.end();
}

run();
