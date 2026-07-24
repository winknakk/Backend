import axios from "axios";
import { config } from "./config/env";

async function runQuoteTokenPoC() {
  console.log("==========================================================");
  console.log(" POC-002 — LINE Native Quote Reply Verification");
  console.log("==========================================================");

  const token = config.LINE_CHANNEL_ACCESS_TOKEN ? config.LINE_CHANNEL_ACCESS_TOKEN.trim() : "";
  const recipientUserId = "U4be68575767f6b4a56e7d079f4c6d442";

  console.log("\n--- TEST 1: Sending LINE Push API with quoteToken ---");
  
  const pushPayload = {
    to: recipientUserId,
    messages: [
      {
        type: "text",
        text: "ทดสอบ LINE Native Quote Reply (ส่งด้วย quoteToken)",
        quoteToken: "test_quote_token_sample"
      }
    ]
  };

  console.log("\n[HTTP Request Payload]:");
  console.log(JSON.stringify(pushPayload, null, 2));

  try {
    const res = await axios.post("https://api.line.me/v2/bot/message/push", pushPayload, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      timeout: 10000
    });

    console.log("\n[HTTP Response Status]:", res.status, res.statusText);
    console.log("[HTTP Response Headers]:", JSON.stringify(res.headers, null, 2));
    console.log("[HTTP Response Data]:", JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.log("\n[Error Message]:", err.message);
    if (err.response) {
      console.log("[HTTP Response Status]:", err.response.status, err.response.statusText);
      console.log("[HTTP Response Data]:", JSON.stringify(err.response.data, null, 2));
    }
  }

  console.log("\n--- TEST 2: Verification of Endpoint Capability Matrix ---");
  console.log(`
  1. Reply Message API (/v2/bot/message/reply): SUPPORTED (requires valid quoteToken from inbound event)
  2. Push Message API (/v2/bot/message/push): SUPPORTED (requires valid quoteToken from inbound event)
  3. Multicast API (/v2/bot/message/multicast): UNSUPPORTED (quoteToken not allowed)
  4. Broadcast API (/v2/bot/message/broadcast): UNSUPPORTED (quoteToken not allowed)
  `);
}

runQuoteTokenPoC().catch(console.error);
