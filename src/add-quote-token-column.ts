import { pool } from "./adapters/postgres/PostgresAdapter";

async function run() {
  console.log("Adding quote_token column to messages table...");
  await pool.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS quote_token TEXT;
  `);
  console.log("✅ Column quote_token added successfully.");
  await pool.end();
}

run().catch(console.error);
