import axios from "axios";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  const baseUrl = "http://localhost:3000";
  const apiKey = process.env.API_KEY || "admin-secret-token-456";
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  const convId = "12";

  try {
    console.log(`\n=== Testing GET /api/admin/conversations/${convId}/messages ===`);
    const msgRes = await axios.get(`${baseUrl}/api/admin/conversations/${convId}/messages`, { headers });
    console.log("Status:", msgRes.status);
    console.log("Messages Data:", JSON.stringify(msgRes.data, null, 2));
  } catch (err: any) {
    console.error("Messages endpoint failed:", err.response?.data || err.message);
  }

  try {
    console.log(`\n=== Testing GET /api/admin/conversations/${convId}/tickets ===`);
    const tixRes = await axios.get(`${baseUrl}/api/admin/conversations/${convId}/tickets`, { headers });
    console.log("Status:", tixRes.status);
    console.log("Tickets Data:", JSON.stringify(tixRes.data, null, 2));
  } catch (err: any) {
    console.error("Tickets endpoint failed:", err.response?.data || err.message);
  }

  try {
    console.log(`\n=== Testing GET /api/admin/conversations/${convId}/profile ===`);
    const profRes = await axios.get(`${baseUrl}/api/admin/conversations/${convId}/profile`, { headers });
    console.log("Status:", profRes.status);
    console.log("Profile Data:", JSON.stringify(profRes.data, null, 2));
  } catch (err: any) {
    console.error("Profile endpoint failed:", err.response?.data || err.message);
  }
}

run();
