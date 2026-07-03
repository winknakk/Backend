import axios from "axios";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  const baseUrl = "http://localhost:3000";
  const apiKey = process.env.API_KEY || "admin-secret-token-456";
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  try {
    const res = await axios.get(`${baseUrl}/api/admin/conversations`, { headers });
    console.log("Conversations Count:", res.data.length);
    console.log("Full data:", JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error("Failed to fetch conversations:", err.message);
  }
}

run();
