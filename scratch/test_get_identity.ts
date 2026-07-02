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
const tableIdentities = "mdcx97m31w3qxru";

async function run() {
  const senderId = "U6256f0c1dbb64edacf9cca92904e49b1";
  const channel = "line";

  console.log("1. Querying with channel_ref only...");
  try {
    const res = await axios.get(`${baseUrl}/api/v1/db/data/v1/${baseId}/${tableIdentities}`, {
      headers: { "xc-token": apiToken },
      params: {
        where: `(channel_ref,eq,${senderId})`,
        limit: 1,
      }
    });
    console.log("Success! Rows:", res.data.list.length);
  } catch (err: any) {
    console.error("Failed 1:", err.response?.status, err.response?.data || err.message);
  }

  console.log("\n2. Querying with channel and channel_ref using ~and...");
  try {
    const res = await axios.get(`${baseUrl}/api/v1/db/data/v1/${baseId}/${tableIdentities}`, {
      headers: { "xc-token": apiToken },
      params: {
        where: `~and((channel,eq,${channel}),(channel_ref,eq,${senderId}))`,
        limit: 1,
      }
    });
    console.log("Success! Rows:", res.data.list.length);
  } catch (err: any) {
    console.error("Failed 2:", err.response?.status, err.response?.data || err.message);
  }
}

run();
