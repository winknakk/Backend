import axios from "axios";
import { AdapterFactory } from "../src/adapters/AdapterFactory";
import { TakeoverManager } from "../src/human-takeover/TakeoverManager";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  console.log("--- Testing Manual AI Handoff Release ---");

  const dbAdapter = AdapterFactory.getAdapter();
  const takeoverManager = new TakeoverManager();

  const conversationId = "1"; // sample conversation ID

  // 1. Simulate Handoff Human state
  console.log("\n1. Setting status to human...");
  await dbAdapter.updateHandoffState(conversationId, "human");
  takeoverManager.setTakeoverState(conversationId, "ACTIVE_HUMAN", "human_agent_admin", 3600000);

  let dbConv = await dbAdapter.getConversation(conversationId);
  let state = takeoverManager.getTakeoverState(conversationId);
  console.log("DB handled_by:", dbConv.handled_by);
  console.log("Takeover status:", state.status);
  console.log("Takeover human_session_started_at:", state.human_session_started_at);

  // 2. Perform release call (POST /api/admin/conversations/:id/release)
  console.log("\n2. Executing release request...");
  const serverUrl = "http://localhost:3000";
  try {
    const res = await axios.post(`${serverUrl}/api/admin/conversations/${conversationId}/release`, {}, {
      headers: { "Content-Type": "application/json" }
    });
    console.log("Release Response:", res.data);
  } catch (err: any) {
    console.error("Release failed:", err.response?.data || err.message);
  }

  // 3. Verify status and session timestamps are cleared
  console.log("\n3. Verifying updated state...");
  dbConv = await dbAdapter.getConversation(conversationId);
  const reloadedTakeoverManager = new TakeoverManager();
  state = reloadedTakeoverManager.getTakeoverState(conversationId);
  console.log("DB handled_by:", dbConv.handled_by); // should be ai
  console.log("Takeover status:", state.status); // should be ACTIVE_AI
  console.log("Takeover human_session_started_at:", state.human_session_started_at); // should be null

  // 4. Verify Idempotency (release again)
  console.log("\n4. Executing release request again (idempotency check)...");
  try {
    const res = await axios.post(`${serverUrl}/api/admin/conversations/${conversationId}/release`, {}, {
      headers: { "Content-Type": "application/json" }
    });
    console.log("Release Response (2nd call):", res.data);
  } catch (err: any) {
    console.error("Release 2nd call failed:", err.response?.data || err.message);
  }
}

run().catch(console.error);
