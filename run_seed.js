const { Client } = require('pg');
const fs = require('fs');

const connectionString = 'postgresql://postgres:15969win@localhost:5432/postgres';
const client = new Client({ connectionString });

async function run() {
  await client.connect();
  console.log("Connected to PostgreSQL database!");
  
  const sql = fs.readFileSync('database/seeds/seed_demo.sql', 'utf8');
  console.log("Running seed_demo.sql...");
  
  await client.query(sql);
  console.log("Seed data applied successfully!");
  
  await client.end();
}

run().catch(err => {
  console.error("Failed to run seed:", err);
  process.exit(1);
});
