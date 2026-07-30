import pg from "pg";

async function testConn(sslOption) {
  console.log(`Testing with SSL option:`, sslOption);
  const client = new pg.Client({
    host: "postgres.promptxai.com",
    port: 5432,
    database: "csdb",
    user: "cs_user",
    password: "F52Gs8w46001",
    ssl: sslOption,
    connectionTimeoutMillis: 5000,
  });

  try {
    await client.connect();
    console.log("SUCCESS connected with ssl:", sslOption);
    await client.end();
    return true;
  } catch (e) {
    console.log("FAILED with ssl:", sslOption, "Error:", e.message);
    return false;
  }
}

async function run() {
  if (await testConn(false)) return;
  if (await testConn({ rejectUnauthorized: false })) return;
  if (await testConn(true)) return;
}

run();
