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
  NOCODB_TOKEN: z.string().min(1, "NOCODB_TOKEN is required"),
  NOCODB_BASE_ID: z.string().default("pr3qdqjih5dlv8o"),
  ACTIVEPIECES_WORKFLOW_PROVIDER: z.enum(["nocodb_v1", "postgres_v2"]).default("nocodb_v1"),
  ACTIVEPIECES_HUMAN_REPLY_WEBHOOK_URL: z.string().url().default("https://wf.promptxai.com/api/v1/webhooks/HGkKjrGFq4Aw2wmaZLK7j"),
  ACTIVEPIECES_PROMOTE_TICKET_WEBHOOK_URL: z.string().url().default("https://wf.promptxai.com/api/v1/webhooks/cprgnt201vTw2zX8YQycQ"),
  ACTIVEPIECES_HUMAN_REPLY_WEBHOOK_URL_V2: z.string().url().default("https://wf.promptxai.com/api/v1/webhooks/v2-human-reply"),
  ACTIVEPIECES_PROMOTE_TICKET_WEBHOOK_URL_V2: z.string().url().default("https://wf.promptxai.com/api/v1/webhooks/v2-promote-ticket"),
  PROMPTX_MCP_URL: z.string().url(),
  PROMPTX_MCP_TOKEN: z.string().min(1, "PROMPTX_MCP_TOKEN is required"),
  PROMPTX_FLOW_WEBHOOK_URL: z.string().url().default("https://wf.promptxai.com/api/v1/webhooks/Tj4kqSult1bbWIx2I2w4H"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  API_KEY: z.string().optional(),
  WEBHOOK_SECRET: z.string().optional(),
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
  PLANE_API_URL: z.string().url().default("https://api.plane.so"),
  PLANE_API_KEY: z.string().default("plane_mock_key"),
  PLANE_PROJECT_ID: z.string().default("proj_id"),
  PLANE_WORKSPACE_SLUG: z.string().default("ws_id"),
  PLANE_WEBHOOK_SECRET: z.string().optional(),
  PLANE_REVERSE_SYNC_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  PLANE_REVERSE_SYNC_INTERVAL_MS: z.coerce.number().int().min(10000).default(30000),
  PLANE_REVERSE_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(25).default(25),
  DB_POOL_MAX: z.coerce.number().default(10),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().default(30000),
  DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().default(2000),
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
  return (result.data || {}) as Env;
};
export const config = validateEnv();
