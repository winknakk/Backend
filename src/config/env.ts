import { z } from "zod";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

// Load .env file from the ticket_codebase directory.
const envPath = path.resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });

function fsLikeExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export const EnvSchema = z.object({
  DATABASE_PROVIDER: z.enum(["local", "nocodb", "postgres"]).default("local"),
  DATABASE_URL: z.string().optional(),
  DATABASE_REPLICA_URL: z.string().optional(),
  NOCODB_BASE_URL: z.string().url().default("https://app.nocodb.com/"),
  NOCODB_URL: z.string().url().default("https://app.nocodb.com/"),
  NOCODB_TOKEN: z.string().default("unused_placeholder_token"),
  NOCODB_BASE_ID: z.string().default("pr3qdqjih5dlv8o"),
  ACTIVEPIECES_WORKFLOW_PROVIDER: z.enum(["nocodb_v1", "postgres_v2"]).default("postgres_v2"),
  ACTIVEPIECES_HUMAN_REPLY_WEBHOOK_URL: z.string().url().default("https://wf.promptxai.com/api/v1/webhooks/HGkKjrGFq4Aw2wmaZLK7j"),
  ACTIVEPIECES_PROMOTE_TICKET_WEBHOOK_URL: z.string().url().default("https://wf.promptxai.com/api/v1/webhooks/cprgnt201vTw2zX8YQycQ"),
  ACTIVEPIECES_HUMAN_REPLY_WEBHOOK_URL_V2: z.string().url().default("https://wf.promptxai.com/api/v1/webhooks/v2-human-reply"),
  ACTIVEPIECES_PROMOTE_TICKET_WEBHOOK_URL_V2: z.string().url().default("https://wf.promptxai.com/api/v1/webhooks/v2-promote-ticket"),
  PROMPTX_HUMAN_REPLY_WEBHOOK_URL: z.string().url().optional(),
  PROMPTX_PROMOTE_TICKET_WEBHOOK_URL: z.string().url().optional(),
  PROMPTX_MCP_URL: z.string().url().default("https://wf.promptxai.com/api/v1/projects/5aWNXP52EIYc1X6COAJUN/mcp-server/http"),
  PROMPTX_MCP_TOKEN: z.string().min(1, "PROMPTX_MCP_TOKEN is required"),
  PROMPTX_FLOW_WEBHOOK_URL: z.string().url().default("https://wf.promptxai.com/api/v1/webhooks/xTSViJNFiBtB4y9RMBYfD"),
  PROMPTX_DIAGNOSTIC_TIMEOUT_MS: z.coerce.number().int().min(500).max(10000).default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  API_KEY: z.string().optional(),
  // Comma-separated list of browser origins allowed to call the API with
  // credentials. An arbitrary reflected origin combined with
  // Access-Control-Allow-Credentials defeats the same-origin policy, so the
  // origin must be matched against this allowlist before it is echoed back.
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000"),
  // Secret used to sign admin session tokens. Required (together with or
  // instead of API_KEY) for the API to serve authenticated requests at all —
  // see authHook, which fails closed when neither is configured.
  // No default, deliberately. A default here is a signing key committed to the
  // repository: every session token and every AgentX execution-context token
  // would be forgeable by anyone who can read this file, and nothing would
  // report that it had happened. Absent means absent — see validateEnv below.
  SESSION_SECRET: z.string().min(32).optional(),
  SESSION_TTL_HOURS: z.coerce.number().min(1).max(168).default(12),
  WEBHOOK_SECRET: z.string().optional(),
  // Enforcement switch for webhook authentication on /api/v1/webhooks/human_notify.
  //
  // Defaults to false because the published Main AI Core flow sends no
  // credential on that call: enabling enforcement before the flow is updated
  // and republished takes human takeover offline. While false the hook logs
  // every unauthenticated call instead of rejecting it, so the flow can be
  // migrated with the evidence visible. Set to true once the live flow node
  // sends the header.
  STRICT_WEBHOOK_AUTH: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  // Opt-in for the demo customer accounts, which sign in with no password at
  // all. Two routes used to do this unconditionally — any username containing
  // "customer" was issued a real 24-hour portal token — so the capability is
  // kept, but only where someone has deliberately asked for it. Production
  // refuses it regardless of this flag; see validateEnv below.
  ALLOW_DEMO_LOGIN: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  RATE_LIMIT_MAX: z.coerce.number().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  EMBEDDING_PROVIDER: z.enum(["mock", "external"]).default("mock"),
  MAX_AGENT_HANDOFF_DEPTH: z.coerce.number().int().positive().default(3),
  POLICY_FILE_PATH: z.string().default("data/policies.json"),
  QUEUE_PROVIDER: z.enum(["redis", "memory"]).default("memory"),
  CACHE_PROVIDER: z.enum(["redis", "memory"]).default("memory"),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  BACKUP_ENCRYPTION_KEY: z.string().default("super-secret-backup-key-32-chars!"),
  BACKEND_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1, "LINE_CHANNEL_ACCESS_TOKEN is required").transform((s) => s.trim()),
  LINE_CHANNEL_SECRET: z.string().min(1).optional(),
  LINE_DM_GATEWAY_WEBHOOK_URL: z.string().url().default("https://wf.promptxai.com/api/v1/webhooks/P7g2NqRKrC8ctzjo71xBi"),
  LINE_GROUP_GATEWAY_WEBHOOK_URL: z.string().url().default("https://wf.promptxai.com/api/v1/webhooks/dRV0RN5vXQLDZ67t9VROo"),
  LINE_ONBOARDING_MODE: z.enum(["code_required", "smart"]).default("code_required"),
  LINE_BATCH_ENABLED: z.coerce.boolean().default(true),
  LINE_BATCH_WINDOW_MS: z.coerce.number().int().min(500).default(2000),
  PROJECT_JOIN_CODE_PEPPER: z.string().min(16).optional(),
  PLANE_API_URL: z.string().url().default("https://api.plane.so"),
  PLANE_API_KEY: z.string().default("plane_mock_key"),
  PLANE_PROJECT_ID: z.string().default("proj_id"),
  PLANE_WORKSPACE_SLUG: z.string().default("ws_id"),
  PLANE_WEBHOOK_SECRET: z.string().optional(),
  PLANE_REVERSE_SYNC_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  PLANE_REVERSE_SYNC_INTERVAL_MS: z.coerce.number().int().min(10000).default(30000),
  PLANE_REVERSE_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(25).default(25),
  DB_POOL_MAX: z.coerce.number().default(10),
  // PostgreSQL is remote (measured ~12 ms per round trip, ~85 ms to open a
  // fresh connection). At 30 s any channel with a gap between messages paid
  // that reconnect on almost every inbound event. Holding idle clients for
  // 10 minutes keeps a warm connection across a normal conversation; the pool
  // already sets TCP keepAlive and evicts clients that die in the meantime.
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().default(600000),
  DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().default(20000),
  HUMAN_PENDING_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
  HUMAN_ACTIVE_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
  HUMAN_MAX_SESSION_MINUTES: z.coerce.number().int().min(5).max(480).default(60),
  // Kept for compatibility with existing deployments. New takeover paths use
  // the explicit pending/active/max policy above.
  HUMAN_SESSION_TIMEOUT_MINUTES: z.coerce.number().default(480),
  MEMORY_SUMMARIZE_THRESHOLD: z.coerce.number().default(8),
  MEMORY_RECENT_MESSAGES_COUNT: z.coerce.number().default(6),
});

export type Env = z.infer<typeof EnvSchema>;

export const validateEnv = (): Env => {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.warn("⚠️  Invalid or incomplete environment variables:");
    result.error.issues.forEach((err) => {
      console.warn(`  - ${err.path.join(".")}: ${err.message}`);
    });
    // In production we strictly throw an error
    if (process.env.NODE_ENV === "production") {
      throw new Error("Strict environment validation failed in Production.");
    }
  }

  const env = (result.data || {}) as Env;

  // SESSION_SECRET is load-bearing, not optional-in-practice.
  //
  // It signs both operator sessions and AgentX execution-context tokens, so
  // without it ExecutionContextService throws and every guarded route fails
  // closed - meaning ticket creation stops. That used to surface only when a
  // customer sent a message and a ticket failed to appear. Refusing to boot
  // says it at deploy time instead, which is the cheapest moment to find out.
  //
  // A substitution used to live here: a missing or short secret was quietly
  // replaced with a constant written into this file. It made the symptom go
  // away and left every token in the system forgeable by anyone holding the
  // source, with nothing in the logs to say so. Do not reintroduce it. If the
  // secret is missing, the answer is to set it - `openssl rand -base64 48`.
  if (process.env.NODE_ENV === "production") {
    const secret = env.SESSION_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error(
        "CONFIGURATION ERROR: SESSION_SECRET must be set to at least 32 characters in production. " +
          "It signs operator sessions and AgentX execution-context tokens; without it, ticket " +
          "creation fails closed at runtime."
      );
    }

    // Demo login issues a portal token to anyone who asks for it. Refusing to
    // boot is the only setting that cannot be undone by a stray environment
    // variable on the production host.
    if (env.ALLOW_DEMO_LOGIN) {
      throw new Error(
        "CONFIGURATION ERROR: ALLOW_DEMO_LOGIN must not be enabled in production. " +
          "It permits password-free sign-in to the customer portal."
      );
    }
  }

  return env;
};
export const config = validateEnv();

