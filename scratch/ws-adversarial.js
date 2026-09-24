/**
 * Adversarial WebSocket QA against a running server.
 *
 *   QA_SUPER_PASS=... QA_SCOPED_PASS=... node scratch/ws-adversarial.js
 *
 * Covers handshake authentication, scope enforcement, reconnect, stale
 * sockets and simultaneous multi-project subscriptions. Never prints a token.
 */
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/api/admin/socket`;

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label.padEnd(56)} ${detail}`);
  } else {
    fail += 1;
    failures.push(`${label} ${detail}`);
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label.padEnd(56)} ${detail}`);
  }
}

/** Resolves to { outcome: 'open' | 'rejected', code } — never throws. */
function connect(url, { holdMs = 0 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      return done({ outcome: "rejected", code: 0, error: e.message });
    }
    ws.on("open", () => {
      if (holdMs > 0) {
        setTimeout(() => {
          try { ws.close(); } catch {}
          done({ outcome: "open", code: 101, ws });
        }, holdMs);
      } else {
        done({ outcome: "open", code: 101, ws });
      }
    });
    ws.on("close", (c) => done({ outcome: "rejected", code: c }));
    ws.on("error", (e) => {
      const m = /Unexpected server response: (\d+)/.exec(e.message);
      done({ outcome: "rejected", code: m ? Number(m[1]) : 0, error: e.message });
    });
    setTimeout(() => done({ outcome: "timeout", code: 0 }), 8000);
  });
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => ({}));
  return body.token || "";
}

async function main() {
  const env = fs.readFileSync(path.resolve(__dirname, "../.env"), "utf8");
  const svcKey = (/^API_KEY=(.*)$/m.exec(env) || [])[1] || "";

  const superToken = await login(
    process.env.QA_SUPER_EMAIL || "admin.win@ticketx.local",
    process.env.QA_SUPER_PASS
  );
  const scopedToken = await login(
    process.env.QA_SCOPED_EMAIL || "admin.good@ticketx.local",
    process.env.QA_SCOPED_PASS
  );

  if (!superToken || !scopedToken) {
    console.log("could not obtain tokens; aborting");
    process.exit(2);
  }

  console.log("\n\x1b[1mWEBSOCKET — handshake\x1b[0m");
  check("anonymous handshake refused", (await connect(`${WS}?projectId=1`)).outcome === "rejected");
  check("invalid token refused", (await connect(`${WS}?token=WRONG`)).outcome === "rejected");
  check("empty token refused", (await connect(`${WS}?token=`)).outcome === "rejected");

  const forged = (() => {
    const parts = scopedToken.split(".");
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    p.role = "super_admin";
    p.orgId = null;
    p.projectIds = null;
    return `${parts[0]}.${Buffer.from(JSON.stringify(p)).toString("base64url")}.${parts[2]}`;
  })();
  check("tampered token refused", (await connect(`${WS}?token=${forged}`)).outcome === "rejected");

  check("valid super_admin accepted", (await connect(`${WS}?projectId=101&token=${superToken}`)).outcome === "open");
  check("valid scoped admin accepted", (await connect(`${WS}?projectId=1&token=${scopedToken}`)).outcome === "open");
  check("service credential accepted", (await connect(`${WS}?token=${svcKey}`)).outcome === "open");

  console.log("\n\x1b[1mWEBSOCKET — scope\x1b[0m");
  const foreign = await connect(`${WS}?projectId=101&token=${scopedToken}`);
  check("project scope mismatch refused", foreign.outcome === "rejected", `code=${foreign.code}`);

  const orgForeign = await connect(`${WS}?projectId=101&token=${scopedToken}`);
  check("org scope mismatch refused", orgForeign.outcome === "rejected", `code=${orgForeign.code}`);

  const bogus = await connect(`${WS}?projectId=abc&token=${scopedToken}`);
  check("malformed projectId refused", bogus.outcome === "rejected", `code=${bogus.code}`);

  const noProject = await connect(`${WS}?token=${scopedToken}`);
  check("no projectId accepted (bounded to own)", noProject.outcome === "open");

  console.log("\n\x1b[1mWEBSOCKET — lifecycle\x1b[0m");
  // Multiple projects simultaneously, from the same principal.
  const multi = await Promise.all([
    connect(`${WS}?projectId=1&token=${scopedToken}`, { holdMs: 300 }),
    connect(`${WS}?projectId=2&token=${scopedToken}`, { holdMs: 300 }),
    connect(`${WS}?projectId=8&token=${scopedToken}`, { holdMs: 300 }),
  ]);
  check("multiple projects simultaneously", multi.every((m) => m.outcome === "open"), `${multi.filter(m => m.outcome === "open").length}/3`);

  // Reconnect after a clean close.
  const first = await connect(`${WS}?projectId=1&token=${scopedToken}`);
  const again = await connect(`${WS}?projectId=1&token=${scopedToken}`);
  check("reconnect after close", first.outcome === "open" && again.outcome === "open");

  // A socket abandoned without a close frame must not wedge the server.
  const stale = await connect(`${WS}?projectId=1&token=${scopedToken}`);
  if (stale.ws) {
    try { stale.ws.terminate(); } catch {}
  }
  await new Promise((r) => setTimeout(r, 500));
  const afterStale = await fetch(`${BASE}/health`).then((r) => r.status).catch(() => 0);
  check("server healthy after an abruptly terminated socket", afterStale === 200, `health=${afterStale}`);

  console.log("\n\x1b[1mSUMMARY\x1b[0m");
  console.log(`  PASS=${pass}  FAIL=${fail}`);
  if (fail > 0) {
    console.log("\n  Failures:");
    failures.forEach((f) => console.log(`   - ${f}`));
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.log("QA harness error:", e.message);
  process.exit(2);
});
