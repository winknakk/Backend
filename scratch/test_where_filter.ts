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
const tableMessages = "mnqxhgnkvoayl9q";

async function run() {
  const conversationIds = ["9", "7", "8", "10"];
  for (const cid of conversationIds) {
    try {
      console.log(`\n--- Testing where filter for conversation ${cid} ---`);
      // Try string filter
      const res = await axios.get(`${baseUrl}/api/v1/db/data/v1/${baseId}/${tableMessages}`, {
        headers: { "xc-token": apiToken },
        params: {
          where: `(conversation_id,eq,${cid})`,
          limit: 10,
        },
      });
      const list = res.data?.list || res.data || [];
      console.log(`Using string filter -> Found ${list.length} messages.`);
      if (list.length > 0) {
        console.log("Sample:", list[0].Id, list[0].content);
      }
    } catch (err: any) {
      console.error("Failed:", err.message);
    }
  }
}

run();
