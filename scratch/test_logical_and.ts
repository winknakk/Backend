import axios from "axios";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const apiToken = process.env.NOCODB_TOKEN;
let baseUrl = process.env.NOCODB_URL || process.env.NOCODB_BASE_URL || "https://app.nocodb.com";
if (baseUrl.endsWith("/")) {
  baseUrl = baseUrl.slice(0, -1);
}
const baseId = process.env.NOCODB_BASE_ID || "pr3qdqjih5dlv8o";
const tableConversations = "mjjqloncd2wzfxu";

async function run() {
  const identityId = 1;

  console.log("Testing (identity_id,eq,X)~and(status,eq,open)...");
  try {
    const res = await axios.get(`${baseUrl}/api/v1/db/data/v1/${baseId}/${tableConversations}`, {
      headers: { "xc-token": apiToken },
      params: {
        where: `(identity_id,eq,${identityId})~and(status,eq,open)`,
        limit: 1,
      }
    });
    console.log("Success! Rows:", res.data.list.length);
  } catch (err: any) {
    console.error("Failed:", err.response?.status, err.response?.data || err.message);
  }
}

run();
