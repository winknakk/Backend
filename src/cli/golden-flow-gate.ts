/**
 * Golden Flow demo gate — preflight and real-journey verifier.
 *
 *   npx tsx src/cli/golden-flow-gate.ts preflight [--base https://staging.host]
 *   npx tsx src/cli/golden-flow-gate.ts verify --line-user <LINE userId> [--since 30m]
 *
 * `preflight` checks every gate that must pass BEFORE a human sends the real
 * LINE message, so the run is not wasted discovering a missing secret.
 *
 * `verify` runs AFTER the human has sent it. It observes what the system
 * actually recorded and asserts each stage of the journey, then prints the
 * evidence block. It never sends anything, never writes to the database, and
 * never fabricates an event — the first system boundary stays the real LINE
 * webhook.
 *
 * No credential value is ever printed.
 */
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";

const args = process.argv.slice(2);
const mode = args[0];
const flag = (name: string, fallback = ""): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

let pass = 0;
let fail = 0;
let blocked = 0;
const failures: string[] = [];

function report(status: "PASS" | "FAIL" | "BLOCKED", label: string, detail = "") {
  if (status === "PASS") pass += 1;
  else if (status === "FAIL") {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    blocked += 1;
    failures.push(`${label} (BLOCKED)${detail ? ` — ${detail}` : ""}`);
  }
  const colour = status === "PASS" ? "\x1b[32m" : status === "FAIL" ? "\x1b[31m" : "\x1b[33m";
  console.log(`  ${colour}${status.padEnd(7)}\x1b[0m ${label}${detail ? `  — ${detail}` : ""}`);
}

function parseSince(v: string): string {
  const m = /^(\d+)([mhd])$/.exec(v || "30m");
  if (!m) return "30 minutes";
  const unit = { m: "minutes", h: "hours", d: "days" }[m[2] as "m" | "h" | "d"];
  return `${m[1]} ${unit}`;
}

// ---------------------------------------------------------------- preflight

async function preflight() {
  const base = flag("base", config.BACKEND_PUBLIC_URL || "");
  console.log("\n\x1b[1mGOLDEN FLOW PREFLIGHT\x1b[0m");
  console.log(`  target: ${base || "(no BACKEND_PUBLIC_URL configured)"}\n`);

  // --- 1. LINE ingestion can happen at all ---
  if (config.LINE_CHANNEL_SECRET) {
    report("PASS", "LINE_CHANNEL_SECRET is configured");
  } else {
    report("BLOCKED", "LINE_CHANNEL_SECRET is not configured", "the webhook will reject every delivery with 503");
  }
  report(
    config.LINE_CHANNEL_ACCESS_TOKEN ? "PASS" : "BLOCKED",
    "LINE_CHANNEL_ACCESS_TOKEN is configured",
    config.LINE_CHANNEL_ACCESS_TOKEN ? "" : "no acknowledgement can be delivered"
  );

  // --- 2. the reachable build is the remediated one ---
  if (!base) {
    report("BLOCKED", "public base URL known", "set BACKEND_PUBLIC_URL or pass --base");
  } else {
    try {
      const res = await fetch(`${base}/api/v1/auth/me`);
      const body = await res.json().catch(() => ({}) as any);
      if (res.status === 401 && body?.authenticated === false) {
        report("PASS", "deployed build rejects anonymous /api/v1/auth/me");
      } else {
        report(
          "FAIL",
          "deployed build rejects anonymous /api/v1/auth/me",
          `got ${res.status} authenticated=${body?.authenticated} role=${body?.user?.role ?? "-"} — this is NOT the remediated build`
        );
      }
    } catch (e: any) {
      report("BLOCKED", "deployed build reachable", e.message);
    }

    try {
      const res = await fetch(`${base}/api/admin/tickets?projectId=1`);
      report(res.status === 401 ? "PASS" : "FAIL", "admin endpoints require authentication", `got ${res.status}`);
    } catch (e: any) {
      report("BLOCKED", "admin endpoint reachable", e.message);
    }
  }

  // --- 3. staging tenant ---
  const projectId = parseInt(flag("project-id", "301"), 10);
  const proj = await pool
    .query(`SELECT id, org_id, name FROM projects WHERE id = $1`, [projectId])
    .catch(() => null);
  if (proj?.rows?.length) {
    report("PASS", `staging project ${projectId} exists`, `org=${proj.rows[0].org_id}`);
  } else {
    report("FAIL", `staging project ${projectId} exists`, "run src/cli/setup-staging-project.ts");
  }

  const chan = await pool
    .query(
      `SELECT 1 FROM project_channels WHERE project_id = $1 AND LOWER(channel_type)='line'
        AND COALESCE(is_enabled,TRUE) AND COALESCE(active,TRUE)`,
      [projectId]
    )
    .catch(() => null);
  report(chan?.rows?.length ? "PASS" : "FAIL", `project ${projectId} has an enabled LINE channel`);

  const code = await pool
    .query(`SELECT 1 FROM project_join_codes WHERE project_id = $1 AND status='active'`, [projectId])
    .catch(() => null);
  report(code?.rows?.length ? "PASS" : "FAIL", `project ${projectId} has an active join code`);

  // --- 4. staging Plane mapping ---
  const mapping = await pool
    .query(
      `SELECT id, org_id, workspace_slug, plane_project_id, enabled,
              (credential_ref IS NOT NULL AND credential_ref <> '') AS has_credential
         FROM plane_workspace_mappings
        WHERE project_id = $1 AND archived_at IS NULL`,
      [projectId]
    )
    .catch(() => null);

  if (!mapping?.rows?.length) {
    report("BLOCKED", `Plane mapping for project ${projectId}`, "no mapping — a Plane issue cannot be created");
  } else {
    const m = mapping.rows[0];
    report(m.enabled ? "PASS" : "FAIL", `Plane mapping for project ${projectId} is enabled`,
      `workspace=${m.workspace_slug} planeProject=${m.plane_project_id}`);
    report(m.has_credential ? "PASS" : "FAIL", "Plane mapping has a credential reference");
    // Never print the credential; only whether it resolves.
    const isProdSlug = ["ticken", "ask-natapohn", "cs-team"].includes(String(m.workspace_slug));
    report(
      isProdSlug ? "FAIL" : "PASS",
      "Plane mapping points at a NON-production workspace",
      isProdSlug ? `'${m.workspace_slug}' is a known production workspace — do not run destructive tests here` : ""
    );
  }

  // --- 5. credential rotation ---
  report(
    "BLOCKED",
    "credentials rotated and old ones revoked",
    "cannot be verified from here; see docs/CREDENTIAL_ROTATION_CHECKLIST.md"
  );

  console.log(`\n  PASS=${pass}  FAIL=${fail}  BLOCKED=${blocked}`);
  if (fail || blocked) {
    console.log("\n  Not ready for the real run:");
    failures.forEach((f) => console.log(`   - ${f}`));
    console.log("\n  \x1b[31mDO NOT send the real LINE message yet.\x1b[0m");
  } else {
    console.log("\n  \x1b[32mPreflight clean — send the real LINE message, then run:\x1b[0m");
    console.log("    npx tsx src/cli/golden-flow-gate.ts verify --line-user <userId>");
  }

  // Non-zero when anything is outstanding, so this can gate a pipeline. A
  // preflight that exits 0 while reporting BLOCKED is worse than none.
  await pool.end().catch(() => {});
  process.exit(fail || blocked ? 1 : 0);
}

// ------------------------------------------------------------------- verify

async function verify() {
  const lineUser = flag("line-user");
  const since = parseSince(flag("since", "30m"));
  const projectId = parseInt(flag("project-id", "301"), 10);

  if (!lineUser) {
    console.log("  --line-user <LINE userId> is required (the staging account that sent the message)");
    process.exit(2);
  }

  console.log("\n\x1b[1mGOLDEN FLOW — REAL JOURNEY VERIFICATION\x1b[0m");
  console.log(`  LINE user: ${lineUser}   project: ${projectId}   window: last ${since}\n`);

  const evidence: Record<string, unknown> = {};

  // 1 — a real webhook was received and recorded.
  const wh = await pool.query(
    `SELECT webhook_event_id, event_type, status, received_at
       FROM line_webhook_events
      WHERE line_user_id = $1 AND received_at > NOW() - $2::interval
      ORDER BY received_at DESC`,
    [lineUser, since]
  );
  if (wh.rows.length === 0) {
    report("FAIL", "a real LINE webhook was received", "no line_webhook_events row for this user in the window");
    console.log("\n  Nothing to verify. The first system boundary was never crossed.");
    await pool.end();
    process.exit(1);
  }
  report("PASS", "a real LINE webhook was received", `${wh.rows.length} event(s)`);
  evidence.line_webhook_event_ids = wh.rows.map((r: any) => r.webhook_event_id);

  // Duplicate protection: each id appears exactly once by construction.
  const distinct = new Set(evidence.line_webhook_event_ids as string[]).size;
  report(
    distinct === (evidence.line_webhook_event_ids as string[]).length ? "PASS" : "FAIL",
    "no duplicate webhook event rows"
  );

  // 2 — identity.
  const ident = await pool.query(
    `SELECT id, profile_id, org_id FROM identities WHERE channel_ref = $1 LIMIT 1`,
    [lineUser]
  );
  report(ident.rows.length ? "PASS" : "FAIL", "identity resolved");
  if (!ident.rows.length) {
    await finish(evidence);
    return;
  }
  evidence.identity_id = ident.rows[0].id;

  // 3 — conversation, in the expected tenant.
  const conv = await pool.query(
    `SELECT id, project_id, org_id FROM conversations
      WHERE identity_id = $1 AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [ident.rows[0].id]
  );
  report(conv.rows.length ? "PASS" : "FAIL", "conversation resolved");
  if (!conv.rows.length) {
    await finish(evidence);
    return;
  }
  const conversationId = conv.rows[0].id;
  evidence.conversation_id = conversationId;
  evidence.project_id = conv.rows[0].project_id;
  evidence.org_id = conv.rows[0].org_id;
  report(
    Number(conv.rows[0].project_id) === projectId ? "PASS" : "FAIL",
    `conversation belongs to project ${projectId}`,
    `got ${conv.rows[0].project_id}`
  );

  // 4 — the customer's message was persisted by the webhook, not by us.
  const msg = await pool.query(
    `SELECT id, external_id, content FROM messages
      WHERE conversation_id = $1 AND role = 'customer' AND external_id IS NOT NULL
      ORDER BY id DESC LIMIT 5`,
    [conversationId]
  );
  report(msg.rows.length ? "PASS" : "FAIL", "customer message persisted", `${msg.rows.length} message(s)`);
  if (msg.rows.length) {
    evidence.message_id = msg.rows[0].id;
    evidence.line_message_external_id = msg.rows[0].external_id;
    const dupes = await pool.query(
      `SELECT external_id, COUNT(*)::int c FROM messages
        WHERE conversation_id = $1 AND external_id IS NOT NULL
        GROUP BY external_id HAVING COUNT(*) > 1`,
      [conversationId]
    );
    report(dupes.rows.length === 0 ? "PASS" : "FAIL", "no duplicate message rows", `${dupes.rows.length} duplicated id(s)`);
  }

  // 5 — acknowledgement, exactly once.
  const acks = await pool.query(
    `SELECT notification_type, COUNT(*)::int c FROM customer_notifications
      WHERE conversation_id = $1 GROUP BY notification_type`,
    [conversationId]
  );
  const ackCount = acks.rows.find((r: any) => r.notification_type === "acknowledgement")?.c ?? 0;
  report(ackCount === 1 ? "PASS" : ackCount === 0 ? "FAIL" : "FAIL", "exactly one acknowledgement", `count=${ackCount}`);
  evidence.notifications = Object.fromEntries(acks.rows.map((r: any) => [r.notification_type, r.c]));

  // 6 — ticket.
  const ticket = await pool.query(
    `SELECT id, ticket_number, status, plane_status, plane_issue_id, plane_project_id, project_id, org_id
       FROM tickets WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`,
    [conversationId]
  );
  if (!ticket.rows.length) {
    report("FAIL", "ticket created", "no ticket for this conversation");
    await finish(evidence);
    return;
  }
  const t = ticket.rows[0];
  report("PASS", "ticket created", `#${t.ticket_number} status=${t.status}`);
  evidence.ticket_id = t.id;
  evidence.ticket_number = t.ticket_number;
  evidence.ticketx_status = t.status;
  evidence.plane_status = t.plane_status;

  const ticketCount = await pool.query(
    `SELECT COUNT(*)::int c FROM tickets WHERE conversation_id = $1`,
    [conversationId]
  );
  report(ticketCount.rows[0].c === 1 ? "PASS" : "FAIL", "exactly one ticket", `count=${ticketCount.rows[0].c}`);

  // 7 — outbox.
  const outbox = await pool.query(
    `SELECT id, event_type, status FROM outbox_events
      WHERE aggregate_id = $1 OR payload->>'ticketId' = $2
      ORDER BY id DESC LIMIT 5`,
    [String(t.id), String(t.ticket_number)]
  );
  report(outbox.rows.length ? "PASS" : "FAIL", "outbox event recorded", `${outbox.rows.length} event(s)`);
  evidence.outbox_event_ids = outbox.rows.map((r: any) => r.id);

  // 8 — Plane linkage.
  if (!t.plane_issue_id) {
    report("FAIL", "Plane issue created and linked", "plane_issue_id is null");
  } else {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t.plane_issue_id);
    report(isUuid ? "PASS" : "FAIL", "plane_issue_id is a real Plane UUID", isUuid ? "" : `got '${t.plane_issue_id}'`);
    report(String(t.plane_issue_id) !== String(t.id) ? "PASS" : "FAIL", "plane_issue_id != ticket_id");
    report(String(t.plane_issue_id) !== String(t.ticket_number) ? "PASS" : "FAIL", "plane_issue_id != external_id");
    report(
      String(t.plane_issue_id) !== String(conversationId) ? "PASS" : "FAIL",
      "plane_issue_id != conversation_id"
    );
    evidence.plane_issue_id = t.plane_issue_id;
    evidence.plane_project_id = t.plane_project_id;

    const linked = await pool.query(
      `SELECT COUNT(*)::int c FROM tickets WHERE plane_issue_id = $1`,
      [t.plane_issue_id]
    );
    report(linked.rows[0].c === 1 ? "PASS" : "FAIL", "only one ticket links to that Plane issue");
  }

  // 9 — audit trail.
  const events = await pool.query(
    `SELECT payload, actor, source FROM ticket_events
      WHERE ticket_id = $1 AND event_type = 'STATUS_TRANSITION' ORDER BY id`,
    [t.id]
  );
  const chain = events.rows.map((r: any) => `${r.payload.from}->${r.payload.to}`);
  report(chain.length > 0 ? "PASS" : "FAIL", "transition audit trail present", `${chain.length} transition(s)`);
  evidence.audit_chain = chain;

  const duplicateTransitions = chain.filter((c, i) => chain.indexOf(c) !== i);
  report(duplicateTransitions.length === 0 ? "PASS" : "FAIL", "no duplicated transition", duplicateTransitions.join(","));

  // 10 — lifecycle outcome.
  if (t.status === "CLOSED") {
    report("PASS", "ticket reached CLOSED");
    const confirmed = chain.some((c) => c.endsWith("->CUSTOMER_CONFIRMED"));
    report(confirmed ? "PASS" : "FAIL", "CLOSED was preceded by CUSTOMER_CONFIRMED");
    const resolvedOnce = chain.filter((c) => c.endsWith("->RESOLVED")).length;
    report(resolvedOnce === 1 ? "PASS" : "FAIL", "exactly one RESOLVED transition", `count=${resolvedOnce}`);
    const resNotifs = acks.rows.find((r: any) => r.notification_type === "resolution_confirmation")?.c ?? 0;
    report(resNotifs === 1 ? "PASS" : "FAIL", "exactly one resolution notification", `count=${resNotifs}`);
  } else if (t.status === "RESOLVED") {
    report("BLOCKED", "ticket reached CLOSED", "still RESOLVED — the customer has not confirmed yet");
  } else {
    report("BLOCKED", "ticket reached CLOSED", `still ${t.status} — Plane has not been moved to Done yet`);
  }

  await finish(evidence);
}

async function finish(evidence: Record<string, unknown>) {
  console.log("\n\x1b[1mEVIDENCE\x1b[0m  (no credentials)");
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`\n  PASS=${pass}  FAIL=${fail}  BLOCKED=${blocked}`);
  if (fail || blocked) {
    console.log("\n  Outstanding:");
    failures.forEach((f) => console.log(`   - ${f}`));
    console.log("\n  \x1b[31mVERDICT: DEMO BLOCKED\x1b[0m");
  } else {
    console.log("\n  \x1b[32mVERDICT: the real customer journey completed end to end.\x1b[0m");
  }
  await pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
}

async function main() {
  if (mode === "preflight") await preflight();
  else if (mode === "verify") await verify();
  else {
    console.log("usage:");
    console.log("  npx tsx src/cli/golden-flow-gate.ts preflight [--base URL] [--project-id 301]");
    console.log("  npx tsx src/cli/golden-flow-gate.ts verify --line-user <userId> [--since 30m]");
    process.exit(2);
  }
  await pool.end().catch(() => {});
}

main().catch(async (err) => {
  console.error("gate error:", err.message);
  await pool.end().catch(() => {});
  process.exit(2);
});
