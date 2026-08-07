import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { LineProjectOnboardingService } from "../services/LineProjectOnboardingService";

const backendRoot = path.resolve(__dirname, "../..");
const envPath = path.join(backendRoot, ".env");
const outputPath = path.join(backendRoot, "data", "LINE-Project-Codes.txt");

function currentEnvValue(text: string, name: string): string {
  const match = text.match(new RegExp(`^${name}=(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

function upsertEnvValue(text: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const matcher = new RegExp(`^${name}=.*$`, "m");
  if (matcher.test(text)) return text.replace(matcher, line);
  const ending = text.endsWith("\n") ? "" : "\n";
  return `${text}${ending}${line}\n`;
}

function writeCodeFile(
  generatedAt: string,
  codes: Array<{ projectId: number; projectName: string; code: string }>
): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const lines = [
    "TicketX LINE Project Join Codes",
    `Generated: ${generatedAt}`,
    "",
    "SECURITY: This file contains plaintext onboarding credentials.",
    "Do not commit, upload, email, or paste this file into workflow JSON.",
    "Codes remain valid until explicitly rotated or revoked.",
    "",
    ...codes.flatMap((item) => [
      `Project ID: ${item.projectId}`,
      `Project: ${item.projectName}`,
      `Join Code: ${item.code}`,
      "",
    ]),
  ];
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

async function main(): Promise<void> {
  let envText = fs.readFileSync(envPath, "utf8");
  const existingPepper = currentEnvValue(envText, "PROJECT_JOIN_CODE_PEPPER");
  const existingApiKey = currentEnvValue(envText, "API_KEY");
  const pepper = existingPepper.length >= 16
    ? existingPepper
    : crypto.randomBytes(32).toString("hex");
  const apiKey = existingApiKey.length >= 32
    ? existingApiKey
    : `tx_api_${crypto.randomBytes(32).toString("base64url")}`;

  envText = upsertEnvValue(envText, "PROJECT_JOIN_CODE_PEPPER", pepper);
  envText = upsertEnvValue(envText, "API_KEY", apiKey);
  if (!/^LINE_CHANNEL_SECRET=/m.test(envText)) {
    envText = upsertEnvValue(envText, "LINE_CHANNEL_SECRET", "");
  }
  fs.writeFileSync(envPath, envText, { encoding: "utf8", mode: 0o600 });

  const mappings = await pool.query(
    `SELECT DISTINCT p.id, p.name, p.org_id
     FROM projects p
     JOIN project_channels pc ON pc.project_id = p.id
     WHERE LOWER(pc.channel_type) = 'line'
       AND pc.channel_id IS NOT NULL
       AND pc.channel_id <> ''
       AND COALESCE(pc.is_enabled, TRUE)
       AND COALESCE(pc.active, TRUE)
     ORDER BY p.id`
  );
  if (mappings.rows.length === 0) throw new Error("No enabled LINE Project mappings found");

  const service = new LineProjectOnboardingService(pool, pepper, config.LINE_ONBOARDING_MODE);
  for (const project of mappings.rows) {
    const status = await service.getJoinCodeStatus(Number(project.id), project.org_id || "org_default");
    if (status?.active) {
      throw new Error(
        `Project ${project.id} already has an active code. Revoke it explicitly before running bootstrap.`
      );
    }
  }

  const generatedAt = new Date().toISOString();
  const codes: Array<{ projectId: number; projectName: string; code: string }> = [];
  for (const project of mappings.rows) {
    const result = await service.rotateJoinCode({
      projectId: Number(project.id),
      orgId: project.org_id || "org_default",
      createdBy: "line-onboarding-bootstrap",
    });
    codes.push({ projectId: result.projectId, projectName: result.projectName, code: result.code });
    writeCodeFile(generatedAt, codes);
  }

  process.stdout.write(
    `Generated secure runtime values without printing them.\n` +
    `Created ${codes.length} LINE Project join codes.\n` +
    `Plaintext code file: ${outputPath}\n` +
    `LINE_CHANNEL_SECRET configured: ${Boolean(currentEnvValue(envText, "LINE_CHANNEL_SECRET"))}\n`
  );
}

main()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
