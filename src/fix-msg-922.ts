import { Client } from "pg";

async function fixMsg922() {
  const client = new Client({
    connectionString: "postgresql://cs_user:F52Gs8w46001@postgres.promptxai.com:5432/csdb?options=-c%20search_path%3Dcs_tickets,public",
    connectionTimeoutMillis: 10000,
  });

  await client.connect();
  const res = await client.query(
    "UPDATE messages SET message_type = 'image', content = 'https://api.line.me/v2/bot/message/627825539856204186/content' WHERE id = 922"
  );
  console.log("Updated rows:", res.rowCount);
  await client.end();
}

fixMsg922().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
