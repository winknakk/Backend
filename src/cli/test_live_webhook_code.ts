import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { LineProjectOnboardingService } from "../services/LineProjectOnboardingService";

async function testNewUserFlow() {
  const destination = "Ue5c4a87416737ab2650f7f0d8ca3d593";
  const newUserId = "U_brand_new_person_" + Date.now();

  const service = new LineProjectOnboardingService(
    pool,
    config.PROJECT_JOIN_CODE_PEPPER || "ticketx_project_join_code_pepper_default_2026",
    config.LINE_ONBOARDING_MODE
  );

  console.log("\n--- STEP 1: New user adds bot (Follow) ---");
  const followDecision = await service.processEvent({
    webhookEventId: "evt_follow_" + Date.now(),
    type: "follow",
    userId: newUserId,
    destination,
  });
  console.log("Follow Decision state:", followDecision.state, "action:", followDecision.action);

  console.log("\n--- STEP 2: New user clicks 'มีรหัสโปรเจกต์' ---");
  const postbackDecision = await service.processEvent({
    webhookEventId: "evt_postback_" + Date.now(),
    type: "postback",
    userId: newUserId,
    destination,
    postbackData: "ticketx:onboarding:has_code",
  });
  console.log("Postback Decision state:", postbackDecision.state, "action:", postbackDecision.action, "replyText:", postbackDecision.replyText);

  console.log("\n--- STEP 3: New user types 'TX-PZMG-CHAC' ---");
  const codeDecision = await service.processEvent({
    webhookEventId: "evt_code_" + Date.now(),
    type: "message",
    userId: newUserId,
    destination,
    messageText: "TX-PZMG-CHAC",
  });
  console.log("Code Decision state:", codeDecision.state, "action:", codeDecision.action);
  console.log("Joined Project:", codeDecision.projectName, "conversationId:", codeDecision.conversationId);
  console.log("Reply Text:", codeDecision.replyText);

  console.log("\n--- STEP 4: New user sends subsequent support message ---");
  const msgDecision = await service.processEvent({
    webhookEventId: "evt_msg_" + Date.now(),
    type: "message",
    userId: newUserId,
    destination,
    messageText: "ขอสอบถามเรื่องระบบหน่อยครับ",
  });
  console.log("Subsequent Message Decision action:", msgDecision.action, "reason:", msgDecision.reason, "projectId:", msgDecision.projectId);

  await pool.end();
}

testNewUserFlow().catch(console.error);
