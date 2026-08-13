import fs from "fs";
import path from "path";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { LineProjectOnboardingService } from "../services/LineProjectOnboardingService";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function writeHandoffCode(projectId: number, projectName: string, code: string): string {
  const outputPath = path.resolve(__dirname, "../../data/LINE-Project-Codes.txt");
  const block = `Project ID: ${projectId}\nProject: ${projectName}\nJoin Code: ${code}`;
  const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  const escapedProjectId = String(projectId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(
    `Project ID: ${escapedProjectId}\\r?\\nProject: [^\\r\\n]*\\r?\\nJoin Code: [^\\r\\n]*`,
    "m"
  );
  const updated = matcher.test(existing)
    ? existing.replace(matcher, block)
    : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}\n`;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, updated.endsWith("\n") ? updated : `${updated}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return outputPath;
}

function readHandoffCode(projectId: number): string {
  const inputPath = path.resolve(__dirname, "../../data/LINE-Project-Codes.txt");
  if (!fs.existsSync(inputPath)) throw new Error("LINE Project code handoff file not found");
  const escapedProjectId = String(projectId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(
    `Project ID: ${escapedProjectId}\\r?\\nProject: [^\\r\\n]*\\r?\\nJoin Code: ([^\\r\\n]+)`,
    "m"
  );
  const match = fs.readFileSync(inputPath, "utf8").match(matcher);
  if (!match) throw new Error(`Project ${projectId} code not found in the handoff file`);
  return match[1].trim();
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "mappings") {
    const result = await pool.query(
      `SELECT pc.project_id, p.name, p.org_id, pc.channel_type,
              (pc.channel_id IS NOT NULL AND pc.channel_id <> '') AS has_destination,
              SUBSTR(MD5(COALESCE(pc.channel_id, '')), 1, 8) AS destination_key,
              COALESCE(pc.is_enabled, TRUE) AS enabled,
              COALESCE(pc.active, TRUE) AS active
       FROM project_channels pc
       JOIN projects p ON p.id = pc.project_id
       ORDER BY pc.project_id`
    );
    process.stdout.write(`${JSON.stringify(result.rows, null, 2)}\n`);
    return;
  }
  const projectId = Number(argument("project-id"));
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new Error("Use --project-id=<positive integer>");
  }
  const projectResult = await pool.query(
    `SELECT id, name, org_id FROM projects WHERE id = $1 LIMIT 1`,
    [projectId]
  );
  if (projectResult.rows.length === 0) throw new Error("Project not found");
  const project = projectResult.rows[0];
  const pepper = config.PROJECT_JOIN_CODE_PEPPER ||
    (config.NODE_ENV === "production" ? "" : config.LINE_CHANNEL_ACCESS_TOKEN);
  const service = new LineProjectOnboardingService(pool, pepper, config.LINE_ONBOARDING_MODE);

  if (command === "rotate") {
    const expiresAtValue = argument("expires-at");
    const expiresAt = expiresAtValue ? new Date(expiresAtValue) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error("Invalid --expires-at value");
    const result = await service.rotateJoinCode({
      projectId,
      orgId: project.org_id || "org_default",
      createdBy: "line-project-code-cli",
      expiresAt,
    });
    if (hasFlag("write-handoff-file")) {
      const outputPath = writeHandoffCode(result.projectId, result.projectName, result.code);
      process.stdout.write(
        `Project: ${result.projectName} (${result.projectId})\n` +
        `New LINE project code stored securely in: ${outputPath}\n`
      );
      return;
    }
    process.stdout.write(
      `Project: ${result.projectName} (${result.projectId})\n` +
      `New LINE project code: ${result.code}\n` +
      "This plaintext value is shown once. Store and distribute it securely.\n"
    );
    return;
  }
  if (command === "status") {
    const result = await service.getJoinCodeStatus(projectId, project.org_id || "org_default");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "restore-handoff") {
    const result = await service.restoreJoinCode({
      projectId,
      orgId: project.org_id || "org_default",
      code: readHandoffCode(projectId),
      createdBy: "line-project-code-cli-restore",
    });
    process.stdout.write(
      `Project: ${result.projectName} (${result.projectId})\n` +
      `Restored active LINE project code from the secure handoff file (hint: ${result.codeHint}).\n`
    );
    return;
  }
  if (command === "revoke") {
    const revoked = await service.revokeJoinCode(projectId, project.org_id || "org_default");
    process.stdout.write(`${revoked ? "Revoked" : "No active code"}\n`);
    return;
  }
  throw new Error("Command must be rotate, restore-handoff, status, or revoke");
}

main()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
