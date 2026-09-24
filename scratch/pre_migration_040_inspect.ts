/**
 * Pre-migration inspection for 040 (two-layer ticket status).
 *
 * Read-only. Answers the questions that must be answered before the CHECK
 * constraint goes on: what statuses exist, which of them the new vocabulary
 * would reject, and what the backfill will produce.
 */
import { Pool } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";
import { TICKET_LIFECYCLE_STATUSES } from "../src/domain/ticket/TicketLifecycle";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

/** The backfill in migration 040, mirrored here so it can be dry-run. */
function backfill(status: string): string {
  switch (String(status || "").trim().toLowerCase()) {
    case "backlog":
      return "NEW";
    case "todo":
    case "to do":
    case "unstarted":
      return "TRIAGED";
    case "open":
      return "OPEN";
    case "in progress":
    case "in_progress":
    case "started":
      return "IN_PROGRESS";
    // Historical Done/closed tickets are finished business. Mapping them to
    // RESOLVED would queue resolution notifications for weeks-old tickets.
    case "done":
    case "complete":
    case "completed":
    case "closed":
    case "resolved":
      return "CLOSED";
    case "cancelled":
    case "canceled":
      return "CANCELLED";
    default:
      return "NEW";
  }
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
  try {
    console.log("=== 1. Existing tickets.status values ===");
    const dist = await pool.query(
      `select status, count(*)::int c from cs_tickets.tickets group by 1 order by 2 desc`
    );
    dist.rows.forEach((r: any) => console.log(`  ${String(r.status).padEnd(16)} ${r.c}`));

    console.log("\n=== 2. Values the new CHECK constraint would REJECT (pre-backfill) ===");
    const valid = new Set<string>(TICKET_LIFECYCLE_STATUSES as readonly string[]);
    const invalid = dist.rows.filter((r: any) => !valid.has(String(r.status)));
    if (invalid.length === 0) {
      console.log("  none");
    } else {
      invalid.forEach((r: any) => console.log(`  ${String(r.status).padEnd(16)} ${r.c} row(s)  -> would violate`));
      console.log(`  TOTAL rows needing backfill: ${invalid.reduce((n: number, r: any) => n + r.c, 0)}`);
    }

    console.log("\n=== 3. Dry-run backfill result ===");
    const after = new Map<string, number>();
    dist.rows.forEach((r: any) => {
      const mapped = backfill(r.status);
      after.set(mapped, (after.get(mapped) || 0) + r.c);
    });
    [...after.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([s, c]) => console.log(`  ${s.padEnd(20)} ${c}${valid.has(s) ? "" : "   <-- STILL INVALID"}`));

    const stillInvalid = [...after.keys()].filter((s) => !valid.has(s));
    console.log(`  backfill produces only valid statuses: ${stillInvalid.length === 0}`);

    console.log("\n=== 4. Rows that would be notified if Done mapped to RESOLVED ===");
    const doneRows = await pool.query(
      `select count(*)::int c from cs_tickets.tickets
        where lower(btrim(status)) in ('done','complete','completed','closed','resolved')`
    );
    console.log(`  ${doneRows.rows[0].c} ticket(s) — these backfill to CLOSED, so no notification is sent`);

    console.log("\n=== 5. Columns 040 will add (must not already exist) ===");
    const cols = await pool.query(
      `select column_name from information_schema.columns
        where table_schema='cs_tickets' and table_name='tickets'
          and column_name in ('plane_status','lifecycle_changed_at')`
    );
    console.log(`  already present: ${cols.rows.length === 0 ? "none" : cols.rows.map((r: any) => r.column_name).join(", ")}`);

    console.log("\n=== 6. Existing constraint that could conflict ===");
    const con = await pool.query(
      `select conname from pg_constraint where conrelid='cs_tickets.tickets'::regclass and contype='c'`
    );
    console.log(`  check constraints on tickets: ${con.rows.length === 0 ? "none" : con.rows.map((r: any) => r.conname).join(", ")}`);

    console.log("\n=== 7. ticket_events baseline ===");
    const ev = await pool.query(`select count(*)::int c from cs_tickets.ticket_events`);
    console.log(`  rows: ${ev.rows[0].c} (transitions have never been audited)`);
  } catch (e: any) {
    console.log("FAIL:", e.message);
  } finally {
    await pool.end();
  }
}

main();
