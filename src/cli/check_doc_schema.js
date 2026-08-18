const { Client } = require('pg');
const dotenv = require('dotenv');
dotenv.config({ path: 'system/backend/.env' });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('--- Schema of document_embeddings ---');
  const schema = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'document_embeddings';");
  console.table(schema.rows);

  await client.end();
}

run().catch(console.error);
