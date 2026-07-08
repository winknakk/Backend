import { Client } from "pg";

const users = ["postgres", "automationx"];
const passwords = ["15969win", "changeme", "postgres", "admin", "root", "", "123456", "1234"];
const dbs = ["postgres", "automationx"];

async function main() {
  for (const user of users) {
    for (const password of passwords) {
      for (const db of dbs) {
        const client = new Client({
          host: "localhost",
          port: 5432,
          user,
          password,
          database: db,
        });
        try {
          await client.connect();
          console.log(`🎉 SUCCESS: user=${user}, password=${password}, db=${db}`);
          await client.end();
          return;
        } catch (err: any) {
          // ignore auth failures, but print other errors if any
          if (!err.message.includes("authentication failed")) {
            console.log(`Failed with other error (user=${user}, db=${db}):`, err.message);
          }
        }
      }
    }
  }
  console.log("❌ Could not connect with any common credentials.");
}

main();
