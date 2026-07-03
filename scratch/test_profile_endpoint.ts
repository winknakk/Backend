import axios from "axios";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  console.log("--- Testing GET /api/admin/conversations/:id/profile ---");
  const serverUrl = "http://localhost:3000";
  const conversationId = "14";

  try {
    const res = await axios.get(`${serverUrl}/api/admin/conversations/${conversationId}/profile`);
    console.log("Response Status:", res.status);
    console.log("Response Data:", JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error("Profile endpoint failed:", err.response?.data || err.message);
  }
}

run();
