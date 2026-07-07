import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  try {
    await client.connect();
    console.log("Connected to PostgreSQL");

    const colQuery = `
      SELECT table_name, column_name, data_type, character_maximum_length
      FROM information_schema.columns
      WHERE table_name IN ('tickets','conversations','identities','companies','document_embeddings')
      ORDER BY table_name, ordinal_position;
    `;

    const cols = await client.query(colQuery);
    console.log("\n=== Columns Verification ===");
    console.table(cols.rows);

    const migQuery = `
      SELECT * FROM schema_migrations ORDER BY version;
    `;
    const migs = await client.query(migQuery);
    console.log("\n=== Migrations ===");
    console.table(migs.rows);

  } catch (err: any) {
    console.error("Error during verification:", err.message);
  } finally {
    await client.end();
  }
}

run();
