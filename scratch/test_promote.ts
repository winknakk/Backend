import axios from "axios";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  const port = 3000;
  const baseUrl = `http://localhost:${port}`;
  const apiKey = process.env.API_KEY || "admin-secret-token-456";

  console.log("Testing ticket promote endpoint on server:", baseUrl);
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  // POST /api/admin/tickets/9/promote
  try {
    const res = await axios.post(`${baseUrl}/api/admin/tickets/9/promote`, {}, { headers });
    console.log("\n[POST /api/admin/tickets/9/promote]");
    console.log("Status:", res.status);
    console.log("Data:", JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error("Failed /api/admin/tickets/9/promote:", err.message);
    if (err.response) console.error(err.response.status, err.response.data);
  }
}

run();
