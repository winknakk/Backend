import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { LineProjectOnboardingService } from "../services/LineProjectOnboardingService";

async function testWebhook(): Promise<void> {
  const pepper =
    config.PROJECT_JOIN_CODE_PEPPER ||
    config.LINE_CHANNEL_ACCESS_TOKEN ||
    "automationx_default_pepper_key_2026";

  const service = new LineProjectOnboardingService(pool, pepper, config.LINE_ONBOARDING_MODE);

  console.log("=== SIMULATING WEBHOOK EVENT FOR TX-S94B-M23D ===");
  for (let i = 0; i < 5; i++) {
    try {
      const decision = await service.processEvent({
        webhookEventId: `test_evt_${Date.now()}_${i}`,
        type: "message",
        userId: "U367f5ba23c8167bc4b15a7a4e7c52b26",
        destination: "U48cb9897ca17cda31f68856063ecd999",
        messageText: "TX-S94B-M23D",
      });

      console.log("Decision result:");
      console.log(JSON.stringify(decision, null, 2));
      break;
    } catch (e: any) {
      console.error(`Attempt ${i + 1} failed: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  await pool.end();
}

testWebhook().catch(console.error);
