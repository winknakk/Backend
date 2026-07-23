import axios from "axios";

async function test() {
  console.log("=== Testing Admin GET Messages API ===");
  try {
    const res = await axios.get("http://localhost:3000/api/admin/conversations/11/messages?projectId=11");
    console.log(`HTTP Response Status: ${res.status}`);
    console.log("Messages returned count:", res.data.length);
    const msgsWithAtts = res.data.filter((m: any) => m.attachments && m.attachments.length > 0);
    console.log("Messages with hydrated attachments count:", msgsWithAtts.length);
    if (msgsWithAtts.length > 0) {
      console.log("Sample Hydrated Message:", JSON.stringify(msgsWithAtts[0], null, 2));
    }
  } catch (err: any) {
    console.error("API test error:", err.message);
  }
}

test();
