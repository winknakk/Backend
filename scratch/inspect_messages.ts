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
  console.log("Querying messages from NocoDB...");
  try {
    const res = await axios.get(`${baseUrl}/api/v1/db/data/v1/${baseId}/${tableMessages}?limit=50`, {
      headers: { "xc-token": apiToken },
    });
    const list = res.data?.list || res.data || [];
    console.log("Total messages fetched:", list.length);
    
    // Find messages where conversation relation or ID is not null
    const nonNullConvs = list.filter((m: any) => {
      return m.conversation_id !== null || (m.Conversations && m.Conversations.length > 0) || (m.Conversations_id !== undefined);
    });

    console.log("Messages with relations:", nonNullConvs.length);
    if (nonNullConvs.length > 0) {
      console.log("Sample non-null message:", JSON.stringify(nonNullConvs[0], null, 2));
    } else if (list.length > 0) {
      console.log("No messages with conversation relations found in first 50. Printing first message:", JSON.stringify(list[0], null, 2));
    }
  } catch (err: any) {
    console.error("Error:", err.message);
  }
}

run();
