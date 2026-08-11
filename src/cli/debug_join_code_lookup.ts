import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import crypto from "crypto";

function normalizeCode(value: string): string {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function digestCode(code: string, pepper: string): string {
  return crypto
    .createHmac("sha256", pepper)
    .update(normalizeCode(code))
    .digest("hex");
}

async function debugLookup(): Promise<void> {
  console.log("=== DEBUGGING JOIN CODE LOOKUP ===");
  console.log("Input code:", "TX-S94B-M23D");
  const normalized = normalizeCode("TX-S94B-M23D");
  console.log("Normalized:", normalized);

  const pepper1 = config.PROJECT_JOIN_CODE_PEPPER;
  const pepper2 = config.LINE_CHANNEL_ACCESS_TOKEN;
  const pepper3 = "automationx_default_pepper_key_2026";

  console.log("Pepper 1 (config.PROJECT_JOIN_CODE_PEPPER):", pepper1 ? `${pepper1.slice(0, 10)}...` : "(none)");
  console.log("Pepper 2 (config.LINE_CHANNEL_ACCESS_TOKEN):", pepper2 ? `${pepper2.slice(0, 10)}...` : "(none)");

  const digest1 = pepper1 ? digestCode(normalized, pepper1) : null;
  const digest2 = pepper2 ? digestCode(normalized, pepper2) : null;
  const digest3 = digestCode(normalized, pepper3);

  console.log("Digest 1:", digest1);
  console.log("Digest 2:", digest2);
  console.log("Digest 3:", digest3);

  let client: any;
  for (let i = 0; i < 5; i++) {
    try {
      client = await pool.connect();
      break;
    } catch (e) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  if (!client) throw new Error("Could not connect to DB");
  try {
    // 1. Inspect project 101
    const pRes = await client.query(`SELECT * FROM projects WHERE id = 101`);
    console.log("\n--- Projects Table (id=101) ---");
    console.log(JSON.stringify(pRes.rows, null, 2));

    // 2. Inspect all project_channels
    const pcRes = await client.query(`SELECT * FROM project_channels`);
    console.log("\n--- All Project Channels ---");
    console.log(JSON.stringify(pcRes.rows, null, 2));

    // 2b. Inspect recent line_webhook_events
    const wheRes = await client.query(`SELECT webhook_event_id, line_user_id, event_type, status, response, received_at FROM line_webhook_events ORDER BY received_at DESC LIMIT 10`);
    console.log("\n--- Recent LINE Webhook Events (Full Detail) ---");
    console.log(JSON.stringify(wheRes.rows, null, 2));

    // 2c. Inspect line_onboarding_sessions
    const sessRes = await client.query(`SELECT * FROM line_onboarding_sessions ORDER BY updated_at DESC LIMIT 10`);
    console.log("\n--- Recent LINE Onboarding Sessions ---");
    console.log(JSON.stringify(sessRes.rows, null, 2));

    // 3. Inspect project_join_codes for project 101
    const pjcRes = await client.query(`SELECT * FROM project_join_codes WHERE project_id = 101`);
    console.log("\n--- Project Join Codes Table (project_id=101) ---");
    console.log(JSON.stringify(pjcRes.rows, null, 2));

    // 4. Test the exact SQL query from LineProjectOnboardingService.ts
    for (const [name, d] of Object.entries({ digest1, digest2, digest3 })) {
      if (!d) continue;
      const codeResult = await client.query(
        `SELECT c.id AS code_id, c.project_id, c.org_id, p.name AS project_name
         FROM project_join_codes c
         JOIN projects p ON p.id = c.project_id AND p.org_id = c.org_id
         WHERE c.code_digest = $1
           AND c.status = 'active'
           AND (c.expires_at IS NULL OR c.expires_at > NOW())
           AND EXISTS (
             SELECT 1
             FROM project_channels pc
             WHERE pc.project_id = p.id
               AND LOWER(pc.channel_type) = 'line'
               AND COALESCE(pc.is_enabled, TRUE)
               AND COALESCE(pc.active, TRUE)
           )
         LIMIT 1`,
        [d]
      );
      console.log(`\n--- Exact SQL Match Result for ${name} (${d}) ---`);
      console.log(`Matched rows: ${codeResult.rows.length}`);
      if (codeResult.rows.length > 0) {
        console.log(JSON.stringify(codeResult.rows[0], null, 2));
      }
    }

  } finally {
    client.release();
    await pool.end();
  }
}

debugLookup().catch(console.error);
