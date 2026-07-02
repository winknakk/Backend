import axios from "axios";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  const port = 3000;
  const baseUrl = `http://localhost:${port}`;
  const apiKey = process.env.API_KEY || "admin-secret-token-456";

  console.log("Testing endpoints on server:", baseUrl);
  console.log("Using API Key:", apiKey);

  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  // 1. GET /api/admin/conversations
  try {
    const res = await axios.get(`${baseUrl}/api/admin/conversations`, { headers });
    console.log("\n[GET /api/admin/conversations]");
    console.log("Status:", res.status);
    console.log("Count:", res.data.length);
    console.log("Data:", JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error("Failed /api/admin/conversations:", err.message);
    if (err.response) console.error(err.response.status, err.response.data);
  }

  // 2. GET /api/admin/conversations/14/messages (we know 14 exists from our inspect script!)
  try {
    const res = await axios.get(`${baseUrl}/api/admin/conversations/14/messages`, { headers });
    console.log("\n[GET /api/admin/conversations/14/messages]");
    console.log("Status:", res.status);
    console.log("Data:", JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error("Failed /api/admin/conversations/14/messages:", err.message);
    if (err.response) console.error(err.response.status, err.response.data);
  }

  // 3. GET /api/admin/conversations/14/tickets
  try {
    const res = await axios.get(`${baseUrl}/api/admin/conversations/14/tickets`, { headers });
    console.log("\n[GET /api/admin/conversations/14/tickets]");
    console.log("Status:", res.status);
    console.log("Data:", JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error("Failed /api/admin/conversations/14/tickets:", err.message);
    if (err.response) console.error(err.response.status, err.response.data);
  }
}

// Wait 2 seconds for server to start, then run
setTimeout(run, 2000);
