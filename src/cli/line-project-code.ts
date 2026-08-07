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
  if (command === "revoke") {
    const revoked = await service.revokeJoinCode(projectId, project.org_id || "org_default");
    process.stdout.write(`${revoked ? "Revoked" : "No active code"}\n`);
    return;
  }
  throw new Error("Command must be rotate, status, or revoke");
}

main()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
