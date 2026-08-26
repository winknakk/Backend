/**
 * Provisions the dedicated Golden Flow staging project.
 *
 *   npx tsx src/cli/setup-staging-project.ts [--project-id 301] [--org org_staging]
 *
 * Creates (idempotently) a staging organization, company, project, LINE
 * channel binding and a join code. Prints the join code ONCE — it is stored
 * only as a salted digest and cannot be recovered afterwards.
 *
 * Uses a dedicated project so the Golden Flow never runs against production
 * customer data.
 */
import { pool } from "../adapters/postgres/PostgresAdapter";
import { LineProjectOnboardingService } from "../services/LineProjectOnboardingService";
import { config } from "../config/env";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const projectId = parseInt(arg("project-id", "301"), 10);
  const orgId = arg("org", "org_staging");
  const companyId = parseInt(arg("company-id", "301"), 10);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO organizations (id, name, slug, status)
       VALUES ($1, 'TicketX Staging', $2, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [orgId, orgId.replace(/_/g, "-")]
    );

    await client.query(
      `INSERT INTO companies (id, name, created_at, updated_at)
       VALUES ($1, 'TicketX Staging Co', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [companyId]
    );

    await client.query(
      `INSERT INTO projects (id, org_id, company_id, name, project_type, environment, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'Golden Flow Staging', 'support', 'staging', 'active', NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET org_id = EXCLUDED.org_id, status = 'active', updated_at = NOW()`,
      [projectId, orgId, companyId]
    );

    await client.query(
      `INSERT INTO project_channels (project_id, channel_type, is_enabled, active)
       VALUES ($1, 'line', TRUE, TRUE)
       ON CONFLICT DO NOTHING`,
      [projectId]
    );

    await client.query("COMMIT");
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("Failed to provision staging project:", err.message);
    process.exit(1);
  } finally {
    client.release();
  }

  // Mint a join code through the same service that redeems them, so the
  // digest and pepper can never drift apart.
  const pepper = config.PROJECT_JOIN_CODE_PEPPER;
  if (!pepper || pepper.length < 16) {
    console.log("Join code: NOT MINTED — PROJECT_JOIN_CODE_PEPPER is unset or shorter than 16 characters.");
    console.log("Set it, then run: npm run line:project-code");
    await pool.end();
    return;
  }
  const onboarding = new LineProjectOnboardingService(pool, pepper);
  const code = await onboarding
    .rotateJoinCode({ projectId, orgId, createdBy: "staging-setup" })
    .catch((e: any) => {
      console.error("Could not mint a join code:", e.message);
      return null;
    });

  console.log(`Staging project ready: id=${projectId} org=${orgId}`);
  if (code && (code as any).code) {
    console.log(`Join code (shown once): ${(code as any).code}`);
  } else {
    console.log("Join code: mint separately with `npm run line:project-code`");
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error("Failed:", err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
