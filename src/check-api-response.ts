import axios from "axios";

async function testMessagesFetch() {
  try {
    const res = await axios.get("http://localhost:3000/api/admin/conversations/67/messages");
    console.log("=== Messages Response ===");
    console.log(JSON.stringify(res.data, null, 2));

    const imageMsgs = res.data.filter((m: any) => m.attachments && m.attachments.length > 0);
    for (const msg of imageMsgs) {
      for (const att of msg.attachments) {
        console.log("\nTesting fileUrl:", att.fileUrl);
        try {
          const fileRes = await axios.get(att.fileUrl, { responseType: 'arraybuffer' });
          console.log("-> File download SUCCESS! Status:", fileRes.status, "Type:", fileRes.headers["content-type"], "Size:", fileRes.data.length);
        } catch (err: any) {
          console.error("-> File download FAILED:", err.response?.status, err.response?.data || err.message);
        }
      }
    }
  } catch (err: any) {
    console.error("Fetch failed:", err.message);
  }
}

testMessagesFetch();
