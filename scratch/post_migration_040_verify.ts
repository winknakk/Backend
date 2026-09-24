/**
 * Post-migration integrity checks for 040 (two-layer ticket status).
 * Read-only. Every check must pass before the change is considered applied.
 */
import { Pool } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";
import {
  TICKET_LIFECYCLE_STATUSES,
  lifecycleToPlaneStatus,
  TicketLifecycleStatus,
} from "../src/domain/ticket/TicketLifecycle";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
  try {
    console.log("=== Distribution after migration ===");
    const dist = await pool.query(
      `select status, plane_status, count(*)::int c
         from cs_tickets.tickets group by 1,2 order by 3 desc`
    );
    dist.rows.forEach((r: any) =>
      console.log(`  ${String(r.status).padEnd(20)} plane=${String(r.plane_status).padEnd(12)} ${r.c}`)
    );

    console.log("\n=== Integrity ===");

    const valid = new Set<string>(TICKET_LIFECYCLE_STATUSES as readonly string[]);
    const invalid = await pool.query(
      `select count(*)::int c from cs_tickets.tickets where status <> ALL($1::text[])`,
      [[...valid]]
    );
    check("every tickets.status is a valid lifecycle value", invalid.rows[0].c === 0, `${invalid.rows[0].c} invalid`);

    const nullPlane = await pool.query(
      `select count(*)::int c from cs_tickets.tickets where plane_status is null`
    );
    check("every ticket has a plane_status", nullPlane.rows[0].c === 0, `${nullPlane.rows[0].c} null`);

    const badPlane = await pool.query(
      `select count(*)::int c from cs_tickets.tickets
        where plane_status is not null
          and plane_status not in ('Backlog','Open','Done','Cancelled')`
    );
    check("every plane_status is a valid Plane state", badPlane.rows[0].c === 0);

    const noLifecycleTs = await pool.query(
      `select count(*)::int c from cs_tickets.tickets where lifecycle_changed_at is null`
    );
    check("every ticket has lifecycle_changed_at", noLifecycleTs.rows[0].c === 0, `${noLifecycleTs.rows[0].c} null`);

    // No historical ticket may have landed in RESOLVED: that would queue a
    // resolution notification for finished business.
    const resolved = await pool.query(
      `select count(*)::int c from cs_tickets.tickets where status = 'RESOLVED'`
    );
    check(
      "historical Done tickets backfilled to CLOSED, not RESOLVED",
      resolved.rows[0].c === 0,
      `${resolved.rows[0].c} in RESOLVED`
    );

    // Consistency between the two layers, per the approved forward mapping.
    const mismatched: string[] = [];
    for (const row of dist.rows) {
      const expected = lifecycleToPlaneStatus(row.status as TicketLifecycleStatus);
      if (expected && row.plane_status !== expected) {
        mismatched.push(`${row.status}->${row.plane_status} (expected ${expected}) x${row.c}`);
      }
    }
    check(
      "plane_status agrees with the forward mapping",
      mismatched.length === 0,
      mismatched.join("; ")
    );

    console.log("\n=== Constraints and indexes ===");
    const cons = await pool.query(
      `select conname from pg_constraint where conrelid='cs_tickets.tickets'::regclass and contype='c'`
    );
    const names = cons.rows.map((r: any) => r.conname);
    check("tickets_status_lifecycle_check exists", names.includes("tickets_status_lifecycle_check"));
    check("tickets_plane_status_check exists", names.includes("tickets_plane_status_check"));

    const idx = await pool.query(
      `select indexname from pg_indexes where schemaname='cs_tickets' and tablename='tickets'`
    );
    const idxNames = idx.rows.map((r: any) => r.indexname);
    for (const want of ["idx_tickets_lifecycle", "idx_tickets_plane_status", "idx_tickets_awaiting_customer"]) {
      check(`${want} exists`, idxNames.includes(want));
    }

    console.log("\n=== The constraint actually rejects the old vocabulary ===");
    for (const bad of ["Backlog", "open", "Done", "merged"]) {
      try {
        await pool.query("BEGIN");
        await pool.query(`UPDATE cs_tickets.tickets SET status = $1 WHERE id = (SELECT MIN(id) FROM cs_tickets.tickets)`, [bad]);
        await pool.query("ROLLBACK");
        check(`writing '${bad}' is rejected`, false, "it was accepted");
      } catch {
        await pool.query("ROLLBACK").catch(() => {});
        check(`writing '${bad}' is rejected`, true);
      }
    }

    console.log(`\n${failures === 0 ? "ALL INTEGRITY CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  } catch (e: any) {
    console.log("FAIL:", e.message);
  } finally {
    await pool.end();
  }
}

main();
