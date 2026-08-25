import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { LineProjectOnboardingService } from "../services/LineProjectOnboardingService";

async function testNewUserOnboarding(): Promise<void> {
  const pepper =
    config.PROJECT_JOIN_CODE_PEPPER ||
    config.LINE_CHANNEL_ACCESS_TOKEN ||
    "automationx_default_pepper_key_2026";

  const service = new LineProjectOnboardingService(pool, pepper, config.LINE_ONBOARDING_MODE);

  console.log("=== SIMULATING WEBHOOK EVENT FOR NEW USER WITH TX-PZMG-CHAC ===");
  
  for (let i = 1; i <= 5; i++) {
    try {
      const decision = await service.processEvent({
        webhookEventId: `test_pzmg_evt_${Date.now()}_${i}`,
        type: "message",
        userId: "U_brand_new_" + Date.now(),
        destination: "Ue5c4a87416737ab2650f7f0d8ca3d593",
        messageText: "TX-PZMG-CHAC",
      });

      console.log("SUCCESS! Valid Code Decision result for new user with TX-PZMG-CHAC:");
      console.log(JSON.stringify(decision, null, 2));
      break;
    } catch (e: any) {
      console.error(`Attempt ${i} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  await pool.end();
}

testNewUserOnboarding().catch(console.error);
