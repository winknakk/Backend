import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function updateKeys() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/csdb",
    connectionTimeoutMillis: 10000,
  });

  await client.connect();
  await client.query(
    "UPDATE plane_workspace_mappings SET plane_api_key = $1, credential_ref = $1",
    ["plane_api_08c97a9323bf4854b6bae958d7577f60"]
  );
  const res = await client.query("SELECT id, org_id, project_id, plane_project_id, credential_ref FROM plane_workspace_mappings");
  console.log("Updated mappings:", res.rows);
  await client.end();
}

updateKeys().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
