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
  NOCODB_BASE_URL: z.string().url().default("https://app.nocodb.com/"),
  NOCODB_TOKEN: z.string().min(1, "NOCODB_TOKEN is required"),
  PROMPTX_MCP_URL: z.string().url(),
  PROMPTX_MCP_TOKEN: z.string().min(1, "PROMPTX_MCP_TOKEN is required"),
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
});

export type Env = z.infer<typeof EnvSchema>;

export const validateEnv = (): Env => {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.warn("⚠️  Invalid or incomplete environment variables:");
    result.error.issues.forEach(err => {
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
