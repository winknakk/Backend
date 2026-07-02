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
  console.log("Querying conversations table columns from NocoDB...");
  try {
    const res = await axios.get(`${baseUrl}/api/v1/db/data/v1/${baseId}/${tableConversations}?limit=1`, {
      headers: { "xc-token": apiToken },
    });
    const list = res.data?.list || res.data || [];
    if (list.length > 0) {
      console.log("Keys in conversations row:", Object.keys(list[0]));
      console.log("Full sample row:", JSON.stringify(list[0], null, 2));
    } else {
      console.log("No rows found.");
    }
  } catch (err: any) {
    console.error("Error:", err.message);
    if (err.response) console.error(err.response.data);
  }
}

run();
