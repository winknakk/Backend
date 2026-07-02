import axios from "axios";
import * as dotenv from "dotenv";
import * as path from "path";

// Load .env
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const apiToken = process.env.NOCODB_TOKEN;
let baseUrl = process.env.NOCODB_URL || process.env.NOCODB_BASE_URL || "https://app.nocodb.com";
if (baseUrl.endsWith("/")) {
  baseUrl = baseUrl.slice(0, -1);
}
const baseId = process.env.NOCODB_BASE_ID || "pr3qdqjih5dlv8o";

async function run() {
  console.log("NOCODB_URL:", baseUrl);
  console.log("NOCODB_BASE_ID:", baseId);
  console.log("NOCODB_TOKEN present:", !!apiToken);

  if (!apiToken) {
    console.error("Token missing!");
    return;
  }

  const tables = {
    conversations: "mjjqloncd2wzfxu",
    messages: "mnqxhgnkvoayl9q",
    tickets: "mbg1047o9wz4nrm",
    identities: "mdcx97m31w3qxru",
  };

  for (const [name, id] of Object.entries(tables)) {
    try {
      const res = await axios.get(`${baseUrl}/api/v1/db/data/v1/${baseId}/${id}?limit=5`, {
        headers: { "xc-token": apiToken },
      });
      console.log(`\n=== Table: ${name} (${id}) ===`);
      const list = res.data?.list || res.data || [];
      console.log(`Count: ${list.length}`);
      if (list.length > 0) {
        console.log("Sample row:", JSON.stringify(list[0], null, 2));
      }
    } catch (err: any) {
      console.error(`Error querying ${name}:`, err.message);
      if (err.response) {
        console.error("Status:", err.response.status);
        console.error("Data:", err.response.data);
      }
    }
  }
}

run();
