import axios from "axios";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { config } from "./config/env";

async function runLiveQuoteTokenPoC() {
  console.log("==========================================================");
  console.log(" POC-003 — LIVE QUOTETOKEN END-TO-END VERIFICATION");
  console.log("==========================================================");

  // 1. Query latest incoming customer message with non-null quote_token
  console.log("\n[STEP 1]: Querying PostgreSQL database for latest live quote_token...");
  const { rows } = await pool.query(`
    SELECT id, conversation_id, role, content, quote_token, external_id, created_at 
    FROM messages 
    WHERE role = 'customer' AND quote_token IS NOT NULL AND quote_token != ''
    ORDER BY id DESC 
    LIMIT 1;
  `);

  if (rows.length === 0) {
    console.log("\n[STATUS]: POC BLOCKED");
    console.log("[REASON]: No non-null quote_token found in PostgreSQL 'messages' table.");
    console.log("[ACTION REQUIRED]: Send a real customer text message in LINE to populate quote_token.");
    await pool.end();
    return;
  }

  const latestMsg = rows[0];
  console.log("\n[STEP 2]: Captured Real Webhook quote_token:");
  console.log(JSON.stringify(latestMsg, null, 2));

  // 2. Obtain recipient user ID
  const conversationId = latestMsg.conversation_id;
  const identResult = await pool.query(`
    SELECT channel_ref FROM identities i
    JOIN conversations c ON c.customer_id = i.profile_id
    WHERE c.id = $1 LIMIT 1;
  `, [conversationId]);

  const recipientUserId = identResult.rows[0]?.channel_ref || "U4be68575767f6b4a56e7d079f4c6d442";
  const token = config.LINE_CHANNEL_ACCESS_TOKEN ? config.LINE_CHANNEL_ACCESS_TOKEN.trim() : "";

  // 3. Execute live LINE Push API call with authentic quoteToken
  console.log("\n[STEP 3]: Sending real LINE Push API request with authentic quoteToken...");
  const pushPayload = {
    to: recipientUserId,
    messages: [
      {
        type: "text",
        text: `> 💬 ตอบกลับด้วย Native Quote:\nทดสอบระบบ Native Quote Reply`,
        quoteToken: latestMsg.quote_token
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
    console.log("[HTTP Response Data]:", JSON.stringify(res.data, null, 2));
    console.log("\n[VERDICT]: HTTP Request ACCEPTED. Please inspect LINE client UI for native quote rendering.");
  } catch (err: any) {
    console.log("\n[HTTP Response Error Status]:", err.response?.status);
    console.log("[HTTP Response Error Data]:", JSON.stringify(err.response?.data, null, 2));
    console.log("\n[VERDICT]: FAIL — LINE API rejected quoteToken.");
  }

  await pool.end();
}

runLiveQuoteTokenPoC().catch(console.error);
