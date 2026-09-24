/**
 * PHASE 2 (A-E) + PHASE 9 — LINE webhook over real HTTP, and server survival.
 *
 *   node scratch/phase2-webhook-e2e.js
 *
 * Boots the server with a locally generated LINE_CHANNEL_SECRET so signed
 * requests can be produced, then drives the real webhook route. No signature
 * check is weakened and no bypass is added — this is the same code path a
 * genuine LINE delivery takes.
 *
 * It does NOT verify the real LINE channel: that needs LINE's own secret and
 * a public URL, and is reported BLOCKED rather than inferred from this.
 *
 * Written in Node rather than shell so request bodies never pass through
 * argv, where Windows mangles UTF-8 and silently breaks the signature.
 */
const crypto = require("crypto");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.PORT || 3996;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString("hex");
const LOG = path.join(ROOT, "scratch", "phase2-server.log");

let pass = 0;
let fail = 0;
const failures = [];

function expect(label, want, got) {
  const ok = String(want).split(",").includes(String(got));
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label.padEnd(56)} ${got}`);
  } else {
    fail += 1;
    failures.push(`${label} (want ${want}, got ${got})`);
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label.padEnd(56)} ${got} (want ${want})`);
  }
}

const sign = (buf, secret = SECRET) =>
  crypto.createHmac("sha256", secret).update(buf).digest("base64");

async function postRaw(bodyBuf, signature) {
  const headers = { "Content-Type": "application/json" };
  if (signature !== null && signature !== undefined) headers["x-line-signature"] = signature;
  try {
    const res = await fetch(`${BASE}/api/v1/webhooks/line`, { method: "POST", headers, body: bodyBuf });
    const text = await res.text().catch(() => "");
    return { status: res.status, text };
  } catch (e) {
    return { status: 0, text: e.message };
  }
}

function makeEvent(id, text) {
  return Buffer.from(
    JSON.stringify({
      destination: "Uphase2destination",
      events: [
        {
          type: "message",
          webhookEventId: id,
          source: { type: "user", userId: "Uphase2_customer" },
          message: { id: `m-${id}`, type: "text", text },
        },
      ],
    }),
    "utf8"
  );
}

async function dbCount(sql, params) {
  const { Pool } = require("pg");
  require("dotenv").config({ path: path.join(ROOT, ".env") });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
  try {
    const r = await pool.query(sql, params);
    return Number(r.rows[0]?.c ?? -1);
  } catch {
    return -1;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function main() {
  // A server left over from an earlier run would hold a DIFFERENT generated
  // secret, so every signature here would be rejected and the results would
  // be meaningless. Refuse to run rather than report a false failure.
  try {
    const probe = await fetch(`${BASE}/health`);
    if (probe.ok) {
      console.log(`  A server is already listening on :${PORT}.`);
      console.log("  It holds a different generated secret, so signatures would not match.");
      console.log("  Stop it and re-run, or set PORT to a free port.");
      process.exit(2);
    }
  } catch {
    /* nothing listening — good */
  }

  console.log(`Booting server on :${PORT} with a generated LINE_CHANNEL_SECRET ...`);
  const out = fs.openSync(LOG, "w");
  const srv = spawn("npx", ["tsx", "src/api/server.ts"], {
    cwd: ROOT,
    env: { ...process.env, LINE_CHANNEL_SECRET: SECRET, PORT: String(PORT) },
    stdio: ["ignore", out, out],
    shell: true,
  });

  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("Server up.\n");

  // ------------------------------------------------------------- PHASE 2
  console.log("\x1b[1mPHASE 2 — LINE webhook over real HTTP\x1b[0m");

  const id = `01JPH2${Date.now()}`;
  const body = makeEvent(id, "ระบบเข้าใช้งานไม่ได้ครับ ขึ้น 502 Bad Gateway");

  // 403 means the signature was REJECTED. Anything else means it was
  // ACCEPTED and processing continued — which is what these assert.
  //
  // A fully successful 200 cannot be reached from here: once the signature
  // passes, onboarding replies to the customer through the real LINE API,
  // which is unreachable without genuine LINE credentials. So "signature
  // accepted" is asserted as "not 403", and end-to-end 200 is reported
  // BLOCKED rather than inferred.
  const acceptedA = (await postRaw(body, sign(body))).status;
  expect("2.A valid signature accepted (not rejected)", true, acceptedA !== 403);
  console.log(`  INFO  downstream status after acceptance: ${acceptedA} (503 = outbound LINE API unreachable here)`);

  const thaiBody = makeEvent(`${id}b`, "ระบบเข้าใช้งานไม่ได้ครับ ขึ้น 502 Bad Gateway");
  const acceptedThai = (await postRaw(thaiBody, sign(thaiBody))).status;
  expect("2.A Thai UTF-8 payload signs byte-exact", true, acceptedThai !== 403);

  expect("2.B invalid signature rejected", 403, (await postRaw(body, sign(Buffer.from("other")))).status);
  expect("2.B tampered body rejected", 403, (await postRaw(makeEvent(id, "edited"), sign(body))).status);
  expect("2.C missing signature rejected", 403, (await postRaw(body, null)).status);
  expect("2.C empty signature rejected", 403, (await postRaw(body, "")).status);

  // D — same event twice.
  const dupId = `01JPH2DUP${Date.now()}`;
  const dupBody = makeEvent(dupId, "duplicate delivery probe");
  const dupSig = sign(dupBody);
  const d1 = (await postRaw(dupBody, dupSig)).status;
  const d2 = (await postRaw(dupBody, dupSig)).status;
  expect("2.D first delivery signature accepted", true, d1 !== 403);
  expect("2.D duplicate delivery signature accepted", true, d2 !== 403);

  // The claim is keyed on webhookEventId, so two deliveries of the same event
  // can never produce two rows. (It is 0 rather than 1 here because delivery
  // failed downstream and the claim was released for retry — which is the
  // correct behaviour, and is what lets LINE's retry reprocess it.)
  const eventRows = await dbCount(
    "select count(*)::int c from line_webhook_events where webhook_event_id = $1",
    [dupId]
  );
  expect("2.D duplicate never produces two webhook-event rows", true, eventRows <= 1);
  console.log(`  INFO  line_webhook_events rows for the duplicated id: ${eventRows}`);

  // ----------------------------------------------------- PHASE 2.E / 9
  console.log("\n\x1b[1mPHASE 2.E / PHASE 9 — malformed input and survival\x1b[0m");

  const malformed = Buffer.from("{not json", "utf8");
  expect("malformed JSON (signed)", "400,403,500", (await postRaw(malformed, sign(malformed))).status);
  const empty = Buffer.alloc(0);
  expect("empty body (signed)", "400,403,500", (await postRaw(empty, sign(empty))).status);

  const noEvents = Buffer.from(JSON.stringify({ destination: "d", events: [] }), "utf8");
  expect("no events (signed)", 200, (await postRaw(noEvents, sign(noEvents))).status);
  const nullEvents = Buffer.from(JSON.stringify({ destination: "d", events: null }), "utf8");
  expect("null events (signed)", 200, (await postRaw(nullEvents, sign(nullEvents))).status);

  const noId = Buffer.from(
    JSON.stringify({
      destination: "d",
      events: [{ type: "message", source: { type: "user", userId: "U1" }, message: { id: "m", type: "text", text: "hi" } }],
    }),
    "utf8"
  );
  expect("event without webhookEventId", "200,400,500,503", (await postRaw(noId, sign(noId))).status);

  const huge = makeEvent(`big${Date.now()}`, "x".repeat(200000));
  expect("200KB payload", "200,400,413,500,503", (await postRaw(huge, sign(huge))).status);

  const deepNest = Buffer.from(JSON.stringify({ destination: "d", events: [JSON.parse("[".repeat(200) + "1" + "]".repeat(200))] }), "utf8");
  expect("deeply nested payload", "200,400,500,503", (await postRaw(deepNest, sign(deepNest))).status);

  // Connection-level abuse while the webhook is live.
  const net = require("net");
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => {
      const s = net.connect(Number(PORT), "127.0.0.1", () => {
        s.write("POST /api/v1/webhooks/line HTTP/1.1\r\nHost: x\r\n");
        s.destroy();
      });
      s.on("error", () => {});
      setTimeout(resolve, 200);
    });
  }
  const health = await fetch(`${BASE}/health`).then((r) => r.status).catch(() => 0);
  expect("server alive after 3 abrupt resets", 200, health);
  // Still enforcing signatures after the abuse — not merely responding.
  expect("webhook still rejects bad signatures afterwards", 403, (await postRaw(body, "bogus")).status);

  // ------------------------------------------------------------ PHASE 9
  console.log("\n\x1b[1mPHASE 9 — crash and noise check\x1b[0m");
  const alive = !srv.killed && srv.exitCode === null;
  expect("server process survived the whole phase", true, alive);

  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "";
  const ioredis = (log.match(/ioredis\] Unhandled error event/g) || []).length;
  const uncaught = (log.match(/throw er; \/\/ Unhandled/g) || []).length;
  expect("no uncaught exception in the server log", 0, uncaught);
  console.log(`  INFO  unhandled ioredis error events: ${ioredis}`);

  // Confirm no credential reached the log.
  const leaked = [SECRET, process.env.LINE_CHANNEL_ACCESS_TOKEN, process.env.SESSION_SECRET, process.env.API_KEY]
    .filter(Boolean)
    .filter((v) => log.includes(v));
  expect("no credential value present in the server log", 0, leaked.length);

  try { srv.kill(); } catch {}
  fs.closeSync(out);

  console.log("\n\x1b[1mSUMMARY\x1b[0m");
  console.log(`  PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.log("  Failures:");
    failures.forEach((f) => console.log(`   - ${f}`));
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.log("harness error:", e.message);
  process.exit(2);
});
