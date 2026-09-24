/**
 * Read-only database evidence collector for CURRENT_STATE_AUDIT.md.
 *
 * Run with:  npx tsx scratch/audit-db-evidence.ts
 *
 * Performs no writes. Every query below backs a numbered finding in
 * docs/CURRENT_STATE_AUDIT.md so the audit stays reproducible.
 */
import { Pool } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SCHEMA = "cs_tickets";

async function section(title: string, fn: () => Promise<void>) {
  console.log(`\n=== ${title} ===`);
  try {
    await fn();
  } catch (e: any) {
    console.log("  QUERY FAILED:", e.message);
  }
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });

  await section("A. Connectivity", async () => {
    const r = await pool.query("select current_database() db, current_schema() sch");
    console.log(" ", JSON.stringify(r.rows[0]));
  });

  await section("B. Applied migrations vs migration files (DB-03)", async () => {
    const r = await pool.query("select version from schema_migrations order by 1");
    console.log(`  applied=${r.rows.length}`);
    console.log("  last:", r.rows.slice(-4).map((x) => x.version).join(", "));
  });

  await section("C. Row-level security (SEC-13 / TEN-04)", async () => {
    const rls = await pool.query(
      `select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.relkind='r' and c.relrowsecurity = true`
    );
    const pol = await pool.query("select schemaname, tablename, policyname from pg_policies");
    console.log(`  tables with RLS enabled: ${rls.rows.length}`);
    console.log(`  row security policies:   ${pol.rows.length}`);
  });

  await section("D. Plane credential storage (SEC-09)", async () => {
    const r = await pool.query(
      `select id, org_id, project_id, workspace_slug, enabled,
              (credential_ref = plane_api_key) as credential_ref_equals_secret,
              case when plane_api_key like 'plane_api_%' then 'PLAINTEXT' else 'OTHER' end as key_shape
         from ${SCHEMA}.plane_workspace_mappings order by id`
    );
    r.rows.forEach((x) => console.log("  ", JSON.stringify(x)));
  });

  await section("E. Ticket / Plane linkage retention (PLN-04)", async () => {
    const r = await pool.query(
      `select count(*)::int total,
              count(*) filter (where plane_project_id is null)::int missing_plane_project,
              count(*) filter (where plane_issue_id is null)::int missing_plane_issue
         from ${SCHEMA}.tickets`
    );
    console.log("  ", JSON.stringify(r.rows[0]));
  });

  await section("F. Ticket status vocabulary (ARCH-01)", async () => {
    const r = await pool.query(`select status, count(*)::int c from ${SCHEMA}.tickets group by 1 order by 2 desc`);
    console.log("  ", JSON.stringify(r.rows));
  });

  await section("G. Audit / trace tables actually populated (OPS-01)", async () => {
    const r = await pool.query(
      `select (select count(*)::int from ${SCHEMA}.tickets) tickets,
              (select count(*)::int from ${SCHEMA}.ticket_events) ticket_events,
              (select count(*)::int from ${SCHEMA}.traces) traces,
              (select count(*)::int from ${SCHEMA}.takeover_sessions) takeover_sessions`
    );
    console.log("  ", JSON.stringify(r.rows[0]));
  });

  await section("H. Outbox dead letters (PLN-01)", async () => {
    const byStatus = await pool.query(
      `select status, count(*)::int c from ${SCHEMA}.outbox_events group by 1`
    );
    console.log("  by status:", JSON.stringify(byStatus.rows));
    const failed = await pool.query(
      `select event_type, attempts, left(coalesce(error_message,''),60) err, count(*)::int c
         from ${SCHEMA}.outbox_events where status='failed'
        group by 1,2,3 order by 4 desc`
    );
    failed.rows.forEach((x) => console.log("  ", JSON.stringify(x)));
  });

  await section("I. Orchestrator project-resolution query (RUN-01)", async () => {
    try {
      await pool.query(
        `SELECT id, name FROM ${SCHEMA}.projects
          WHERE (LOWER(name)=LOWER($1) OR LOWER(slug)=LOWER($1) OR LOWER(code)=LOWER($1))
            AND is_active = TRUE LIMIT 1`,
        ["excise"]
      );
      console.log("  query OK");
    } catch (e: any) {
      console.log("  QUERY FAILS AT RUNTIME ->", e.message);
    }
    const cols = await pool.query(
      `select column_name from information_schema.columns
        where table_schema=$1 and table_name='projects'`,
      [SCHEMA]
    );
    const names = cols.rows.map((r) => r.column_name);
    console.log("  projects has 'code'?", names.includes("code"), " 'is_active'?", names.includes("is_active"));
  });

  await pool.end();
}

main();
