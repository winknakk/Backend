import axios from "axios";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  const port = 3000;
  const baseUrl = `http://localhost:${port}`;
  const apiKey = process.env.API_KEY || "admin-secret-token-456";

  console.log("Testing reply and takeover endpoints on server:", baseUrl);
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  // 1. POST /api/admin/conversations/10/takeover
  try {
    const res = await axios.post(`${baseUrl}/api/admin/conversations/10/takeover`, {}, { headers });
    console.log("\n[POST /api/admin/conversations/10/takeover]");
    console.log("Status:", res.status);
    console.log("Data:", JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error("Failed /api/admin/conversations/10/takeover:", err.message);
    if (err.response) console.error(err.response.status, err.response.data);
  }

  // 2. POST /api/admin/conversations/10/reply
  try {
    const res = await axios.post(`${baseUrl}/api/admin/conversations/10/reply`, {
      message: "สวัสดีครับ มีอะไรให้ผมช่วยเหลือเพิ่มเติมไหมครับ?"
    }, { headers });
    console.log("\n[POST /api/admin/conversations/10/reply]");
    console.log("Status:", res.status);
    console.log("Data:", JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error("Failed /api/admin/conversations/10/reply:", err.message);
    if (err.response) console.error(err.response.status, err.response.data);
  }
}

run();
