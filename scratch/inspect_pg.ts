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

    const tables = ["conversations", "messages", "tickets", "identities", "profiles", "companies", "projects"];

    for (const table of tables) {
      console.log(`\n=== Table: ${table} ===`);
      
      // Get column info
      const colRes = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`,
        [table]
      );
      console.log("Columns:", colRes.rows.map(r => `${r.column_name} (${r.data_type})`).join(", "));

      // Get count
      const countRes = await client.query(`SELECT COUNT(*)::integer AS count FROM ${table}`);
      console.log("Count:", countRes.rows[0].count);

      // Get 1 sample row
      if (countRes.rows[0].count > 0) {
        const sampleRes = await client.query(`SELECT * FROM ${table} LIMIT 1`);
        console.log("Sample:", JSON.stringify(sampleRes.rows[0], null, 2));
      }
    }
  } catch (err: any) {
    console.error("Error during inspection:", err.message);
  } finally {
    await client.end();
  }
}

run();
