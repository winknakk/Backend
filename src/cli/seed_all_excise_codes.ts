import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { createHmac } from "crypto";

async function seedAllCodes() {
  const pepper =
    config.PROJECT_JOIN_CODE_PEPPER ||
    config.LINE_CHANNEL_ACCESS_TOKEN ||
    "automationx_default_pepper_key_2026";

  const codesToSeed = ["TX-EXC3-2026", "TX-PZMG-CHAC"];

  let client;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      client = await pool.connect();
      break;
    } catch (err: any) {
      console.warn(`Connection attempt ${attempt} failed: ${err.message}`);
      if (attempt === 5) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  try {
    for (const rawCode of codesToSeed) {
      const normalized = rawCode.trim().toUpperCase().replace(/[\s-]/g, "");
      const digest = createHmac("sha256", pepper).update(normalized).digest("hex");
      const hint = rawCode.slice(-4);

      await client!.query(
        `INSERT INTO project_join_codes (project_id, org_id, code_digest, code_hint, status, usage_count, expires_at, created_at)
         VALUES (101, 'org_excise', $1, $2, 'active', 0, NOW() + INTERVAL '1 year', NOW())
         ON CONFLICT DO NOTHING`,
        [digest, hint]
      );
      console.log(`=== Seeded Join Code: ${rawCode} (digest: ${digest.slice(0, 10)}...) ===`);
    }
    console.log("=== All EXC03 Join Codes successfully seeded ===");
  } catch (e: any) {
    console.error("Error seeding codes:", e.message);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

seedAllCodes().catch(console.error);
