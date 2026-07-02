import axios from "axios";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  const port = 3000;
  const baseUrl = `http://localhost:${port}`;
  const apiKey = process.env.API_KEY || "admin-secret-token-456";
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  // Fetch conversations first
  try {
    const convRes = await axios.get(`${baseUrl}/api/admin/conversations`, { headers });
    const conversations = convRes.data || [];
    console.log(`Found ${conversations.length} conversations.`);

    for (const c of conversations) {
      const msgRes = await axios.get(`${baseUrl}/api/admin/conversations/${c.id}/messages`, { headers });
      console.log(`Conversation ${c.id} (${c.customer}): ${msgRes.data.length} messages`);
      if (msgRes.data.length > 0) {
        console.log("Sample message:", msgRes.data[0]);
      }
    }
  } catch (err: any) {
    console.error("Error:", err.message);
  }
}

run();
