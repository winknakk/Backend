import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { LineProjectOnboardingService } from "../services/LineProjectOnboardingService";

async function testNewUserOnboarding(): Promise<void> {
  const pepper =
    config.PROJECT_JOIN_CODE_PEPPER ||
    config.LINE_CHANNEL_ACCESS_TOKEN ||
    "automationx_default_pepper_key_2026";

  const service = new LineProjectOnboardingService(pool, pepper, config.LINE_ONBOARDING_MODE);

  console.log("=== SIMULATING WEBHOOK EVENT FOR NEW USER WITH ACTIVE JOIN CODE (TX-EXC3-2026) ===");
  
  for (let i = 1; i <= 5; i++) {
    try {
      const decision = await service.processEvent({
        webhookEventId: `test_valid_code_evt_${Date.now()}_${i}`,
        type: "message",
        userId: "U0ac4a8a0651e47441473014866ff1960",
        destination: "U48cb9897ca17cda31f68856063ecd999",
        messageText: "TX-EXC3-2026",
      });

      console.log("SUCCESS! Valid Code Decision result for new user:");
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
