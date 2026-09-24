/**
 * Validates a .env against the constraints in src/config/env.ts, without
 * importing the project. Reports names and verdicts only — never a value.
 *
 * The point: validateEnv() uses safeParse and then `result.data || {}`, so a
 * single failing variable leaves the WHOLE config empty in non-production.
 * SESSION_SECRET then reads as undefined, sessionTokenService is null, and
 * every login returns 503 — for every role, super_admin included.
 */
const fs = require("fs");

const file = process.argv[2];
if (!fs.existsSync(file)) {
  console.error(`not found: ${file}`);
  process.exit(1);
}

const env = {};
for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq === -1) continue;
  env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
}

const REQUIRED = ["PROMPTX_MCP_URL", "PROMPTX_MCP_TOKEN", "LINE_CHANNEL_ACCESS_TOKEN"];

const URL_FIELDS = [
  "NOCODB_BASE_URL", "NOCODB_URL",
  "ACTIVEPIECES_HUMAN_REPLY_WEBHOOK_URL", "ACTIVEPIECES_PROMOTE_TICKET_WEBHOOK_URL",
  "ACTIVEPIECES_HUMAN_REPLY_WEBHOOK_URL_V2", "ACTIVEPIECES_PROMOTE_TICKET_WEBHOOK_URL_V2",
  "PROMPTX_HUMAN_REPLY_WEBHOOK_URL", "PROMPTX_PROMOTE_TICKET_WEBHOOK_URL",
  "PROMPTX_MCP_URL", "PROMPTX_FLOW_WEBHOOK_URL", "BACKEND_PUBLIC_URL",
  "LINE_DM_GATEWAY_WEBHOOK_URL", "LINE_GROUP_GATEWAY_WEBHOOK_URL", "PLANE_API_URL",
];

const ENUMS = {
  DATABASE_PROVIDER: ["local", "nocodb", "postgres"],
  ACTIVEPIECES_WORKFLOW_PROVIDER: ["nocodb_v1", "postgres_v2"],
  NODE_ENV: ["development", "production", "test"],
  LOG_LEVEL: ["trace", "debug", "info", "warn", "error", "fatal"],
  EMBEDDING_PROVIDER: ["mock", "external"],
  QUEUE_PROVIDER: ["redis", "memory"],
  CACHE_PROVIDER: ["redis", "memory"],
  LINE_ONBOARDING_MODE: ["code_required", "smart"],
  PLANE_REVERSE_SYNC_ENABLED: ["true", "false"],
  STRICT_WEBHOOK_AUTH: ["true", "false"],
};

const MIN_LEN = { SESSION_SECRET: 32, PROJECT_JOIN_CODE_PEPPER: 16 };

const NUM_RANGE = {
  SESSION_TTL_HOURS: [1, 168],
  PROMPTX_DIAGNOSTIC_TIMEOUT_MS: [500, 10000],
  HUMAN_PENDING_TIMEOUT_MINUTES: [1, 60],
  HUMAN_ACTIVE_TIMEOUT_MINUTES: [1, 120],
  HUMAN_MAX_SESSION_MINUTES: [5, 480],
  PLANE_REVERSE_SYNC_INTERVAL_MS: [10000, Infinity],
  PLANE_REVERSE_SYNC_BATCH_SIZE: [1, 25],
};

const failures = [];

for (const k of REQUIRED) {
  if (!env[k]) failures.push(`${k}: required, missing or empty`);
}

for (const k of URL_FIELDS) {
  if (env[k] === undefined || env[k] === "") continue;
  try {
    new URL(env[k]);
  } catch {
    failures.push(`${k}: not a valid URL`);
  }
}

for (const [k, allowed] of Object.entries(ENUMS)) {
  if (env[k] === undefined || env[k] === "") continue;
  if (!allowed.includes(env[k])) {
    failures.push(`${k}: must be exactly one of ${allowed.join(" | ")} (case-sensitive) — got a ${env[k].length}-char value that is not`);
  }
}

for (const [k, min] of Object.entries(MIN_LEN)) {
  if (env[k] === undefined || env[k] === "") continue;
  if (env[k].length < min) failures.push(`${k}: length ${env[k].length}, minimum ${min}`);
}

for (const [k, [lo, hi]] of Object.entries(NUM_RANGE)) {
  if (env[k] === undefined || env[k] === "") continue;
  const n = Number(env[k]);
  if (!Number.isFinite(n)) failures.push(`${k}: not a number`);
  else if (n < lo || n > hi) failures.push(`${k}: ${n} outside ${lo}..${hi}`);
}

console.log(`checked: ${file}`);
console.log(`variables present: ${Object.keys(env).length}`);
if (failures.length === 0) {
  console.log("\nRESULT: PASS — config would resolve, SESSION_SECRET survives, login can issue tokens.");
} else {
  console.log(`\nRESULT: FAIL — ${failures.length} issue(s). In non-production this empties the ENTIRE config,`);
  console.log("so SESSION_SECRET reads undefined and EVERY login returns 503, super_admin included.\n");
  failures.forEach((f) => console.log("  - " + f));
}
