#!/usr/bin/env node
/**
 * Verification for the human_notify reorder + webhook auth change.
 *
 * Three modes, cheapest first. Only `flow` costs PromptX credits, and it sends
 * exactly one request — there is no retry loop anywhere in this file.
 *
 *   node verify-human-notify.js direct   [baseUrl]   # 0 credits — middleware
 *   node verify-human-notify.js latency  [baseUrl]   # 0 credits — T1 + T2
 *   node verify-human-notify.js flow     <new|server>#  1 credit  — deployed flow
 *
 * Run `direct` and `latency` against a local backend before spending anything
 * on `flow`.
 */

const DEFAULT_BASE = process.env.BACKEND_BASE_URL || "http://localhost:3000";

const FLOW_URLS = {
  new: "https://wf.promptxai.com/api/v1/webhooks/N4JBqdxYzRKnHEFcx2avE",
  server: "https://wf.promptxai.com/api/v1/webhooks/xTSViJNFiBtB4y9RMBYfD",
};

// The gate must classify this as "the customer wants a human", or the run never
// reaches step_6_b and the credit is spent proving nothing. An incident report
// ("ระบบล่ม ขึ้น 506") goes down the ticket-creation path instead.
const TAKEOVER_PAYLOAD = {
  channel: "postman",
  customer_ref: "postman_tester_247",
  destination: "postman_tester_247",
  project_id: 8,
  org_id: "org_default",
  message: "ขอคุยกับเจ้าหน้าที่ตัวจริงครับ ไม่อยากคุยกับบอทแล้ว",
  message_type: "text",
  onboarding_verified: true,
  onboarding_conversation_id: 1049,
  reply_token: "postman_reply_token",
  quote_token: null,
  line_image_id: null,
};

const CONVERSATION_ID = String(TAKEOVER_PAYLOAD.onboarding_conversation_id);

function line() {
  console.log("─".repeat(72));
}

async function post(url, body, headers = {}) {
  const started = process.hrtime.bigint();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { status: res.status, text, ms };
}

/* ── direct: the middleware, without touching PromptX ────────────────────── */

async function direct(base) {
  const url = `${base}/api/v1/webhooks/human_notify`;
  const secret = process.env.WEBHOOK_SECRET;

  console.log(`POST ${url}`);
  console.log(`WEBHOOK_SECRET in this shell: ${secret ? "set" : "NOT SET"}`);
  line();

  const body = {
    conversationId: CONVERSATION_ID,
    role: "customer",
    content: TAKEOVER_PAYLOAD.message,
    reasonCode: "CUSTOMER_REQUESTED_HUMAN",
    reasonDetail: "verify-human-notify direct probe",
    source: "verification-script",
  };

  const cases = [
    { name: "no credential", headers: {} },
    { name: "wrong secret", headers: { "x-webhook-secret": "definitely-not-the-secret" } },
  ];
  if (secret) {
    cases.push({ name: "correct secret", headers: { "x-webhook-secret": secret } });
  }

  for (const c of cases) {
    const r = await post(url, body, c.headers);
    console.log(`${c.name.padEnd(16)} -> ${r.status}  ${r.ms.toFixed(1)}ms  ${r.text.slice(0, 90)}`);
  }

  line();
  console.log("Expected with STRICT_WEBHOOK_AUTH unset (the rollout default):");
  console.log("  every case 200, and the backend log carries one");
  console.log('  "STRICT_WEBHOOK_AUTH is off. This route is open" per unauthenticated call.');
  console.log("Expected with STRICT_WEBHOOK_AUTH=true:");
  console.log("  no credential -> 403, wrong secret -> 403, correct secret -> 200.");
}

/* ── latency: T1 server-side, T2 socket delivery ─────────────────────────── */

async function latency(base) {
  const token = process.env.ADMIN_SESSION_TOKEN;
  if (!token) {
    console.error("ADMIN_SESSION_TOKEN is required: the admin socket refuses an unauthenticated upgrade.");
    console.error("Take it from the browser's localStorage on a logged-in console session.");
    process.exit(1);
  }

  const projectId = String(process.env.PROJECT_ID || TAKEOVER_PAYLOAD.project_id);
  const wsBase = base.replace(/^http/, "ws");
  const wsUrl = `${wsBase}/api/admin/socket?projectId=${encodeURIComponent(projectId)}&token=${encodeURIComponent(token)}`;

  console.log(`socket  ${wsUrl.replace(/token=[^&]+/, "token=***")}`);
  line();

  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("socket failed to open")), { once: true });
  });

  const received = new Promise((resolve) => {
    socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.event === "NEW_HUMAN_REQUEST") resolve(process.hrtime.bigint());
      } catch {
        /* a malformed frame is not the frame being timed */
      }
    });
  });

  const headers = process.env.WEBHOOK_SECRET ? { "x-webhook-secret": process.env.WEBHOOK_SECRET } : {};
  const sentAt = process.hrtime.bigint();
  const r = await post(
    `${base}/api/v1/webhooks/human_notify`,
    {
      conversationId: CONVERSATION_ID,
      role: "customer",
      content: `latency probe ${new Date().toISOString()}`,
      reasonCode: "CUSTOMER_REQUESTED_HUMAN",
      source: "verification-script",
    },
    headers
  );

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 10000));
  const frameAt = await Promise.race([received, timeout]);
  socket.close();

  line();
  console.log(`T1  HTTP 200 returned            ${r.ms.toFixed(1)} ms   (status ${r.status})`);
  if (frameAt === null) {
    console.log("T2  socket frame                 NOT RECEIVED within 10s");
    console.log("    Check that projectId matches the conversation's project — an");
    console.log("    unresolved project now skips the broadcast rather than guessing.");
  } else {
    const t2 = Number(frameAt - sentAt) / 1e6;
    console.log(`T2  NEW_HUMAN_REQUEST delivered  ${t2.toFixed(1)} ms   (from request start)`);
  }
  line();
  console.log("Record both numbers before and after the reorder. A single run is");
  console.log("not a measurement — take five and report the median.");
}

/* ── flow: one trigger of the deployed PromptX flow ──────────────────────── */

async function flow(which) {
  const url = FLOW_URLS[which];
  if (!url) {
    console.error(`Unknown target ${JSON.stringify(which)}. Use "new" or "server".`);
    process.exit(1);
  }

  console.log(`ONE trigger -> ${url}`);
  console.log(`message: ${TAKEOVER_PAYLOAD.message}`);
  line();

  const r = await post(url, TAKEOVER_PAYLOAD);
  console.log(`${r.status}  ${r.ms.toFixed(0)}ms  ${r.text.slice(0, 300)}`);

  line();
  console.log("Now read the backend log this flow points at, and grep for:");
  console.log('  "STRICT_WEBHOOK_AUTH is off. This route is open"');
  console.log();
  console.log("  ABSENT  -> the flow sent x-webhook-secret. Ready for strict mode.");
  console.log("  PRESENT -> the header did not arrive. Check the value saved in the");
  console.log("             PromptX node, and that the flow was republished.");
}

/* ── entry ───────────────────────────────────────────────────────────────── */

const [mode, arg] = process.argv.slice(2);

const run = {
  direct: () => direct(arg || DEFAULT_BASE),
  latency: () => latency(arg || DEFAULT_BASE),
  flow: () => flow(arg),
}[mode];

if (!run) {
  console.error("usage: node verify-human-notify.js <direct|latency|flow> [baseUrl|new|server]");
  process.exit(1);
}

run().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
