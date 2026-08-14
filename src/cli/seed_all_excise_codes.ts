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

    // Also seed MCP permissions for Project 101 (EXC03)
    await client!.query(
      `INSERT INTO project_mcp_permissions (project_id, tool_name, is_enabled, policy_rules, created_at, updated_at)
       VALUES (101, 'search_project_docs', true, '{"knowledge_base": {"filter_tag": "EXC03"}}'::jsonb, NOW(), NOW())
       ON CONFLICT (project_id, tool_name) DO UPDATE
       SET is_enabled = true, policy_rules = '{"knowledge_base": {"filter_tag": "EXC03"}}'::jsonb, updated_at = NOW()`
    );
    console.log("=== Seeded project_mcp_permissions for Project 101 (EXC03) ===");
    console.log("=== All EXC03 Join Codes & Permissions successfully seeded ===");
  } catch (e: any) {
    console.error("Error seeding codes:", e.message);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

seedAllCodes().catch(console.error);
