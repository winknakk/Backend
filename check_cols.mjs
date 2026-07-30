import pg from "pg";

const client = new pg.Client({
  host: "postgres.promptxai.com",
  port: 5432,
  database: "csdb",
  user: "cs_user",
  password: "F52Gs8w46001",
  ssl: false,
});

async function main() {
  await client.connect();
  const res = await client.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'cs_tickets' AND table_name = 'tickets'
    ORDER BY ordinal_position;
  `);
  console.log("Columns in cs_tickets.tickets:");
  res.rows.forEach(r => console.log(` - ${r.column_name} (${r.data_type})`));
  await client.end();
}

main();
