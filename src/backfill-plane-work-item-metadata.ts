import axios from "axios";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { config } from "./config/env";
import { buildPlaneWorkItemPayload } from "./services/planeService";

interface LinkedTicketRow extends Record<string, any> {
  plane_issue_id: string;
  company_name?: string;
  channel?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function run(): Promise<void> {
  if (
    !config.PLANE_API_KEY ||
    config.PLANE_API_KEY === "plane_mock_key" ||
    !config.PLANE_PROJECT_ID ||
    config.PLANE_PROJECT_ID === "proj_id" ||
    !config.PLANE_WORKSPACE_SLUG ||
    config.PLANE_WORKSPACE_SLUG === "ws_id"
  ) {
    throw new Error("Plane API credentials are not configured");
  }

  const result = await pool.query<LinkedTicketRow>(
    `SELECT
       t.*,
       conv.channel,
       company.name AS company_name
     FROM tickets t
     LEFT JOIN conversations conv ON conv.id = t.conversation_id
     LEFT JOIN identities identity ON identity.id = conv.identity_id
     LEFT JOIN profiles profile ON profile.id = identity.profile_id
     LEFT JOIN companies company ON company.id = profile.company_id
     WHERE t.deleted_at IS NULL
       AND t.plane_issue_id IS NOT NULL
     ORDER BY t.created_at ASC`
  );

  const baseUrl =
    `${config.PLANE_API_URL}/api/v1/workspaces/${encodeURIComponent(config.PLANE_WORKSPACE_SLUG)}` +
    `/projects/${encodeURIComponent(config.PLANE_PROJECT_ID)}/work-items`;
  let updated = 0;
  let skipped = 0;
  const failures: Array<{ ticketNumber: string; reason: string }> = [];

  for (const ticket of result.rows) {
    const ticketNumber = String(
      ticket.ticket_number || ticket.ticket_id || ticket.id
    );
    if (!UUID_PATTERN.test(String(ticket.plane_issue_id))) {
      skipped += 1;
      continue;
    }

    try {
      const payload = buildPlaneWorkItemPayload(
        ticket,
        String(ticket.company_name || "Unknown")
      );
      const workItemUrl = `${baseUrl}/${encodeURIComponent(ticket.plane_issue_id)}/`;
      await axios.patch(
        workItemUrl,
        payload,
        {
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": config.PLANE_API_KEY,
          },
          timeout: 10000,
        }
      );
      const verification = await axios.get(workItemUrl, {
        headers: { "X-API-Key": config.PLANE_API_KEY },
        timeout: 10000,
      });
      if (
        verification.data?.external_id !== payload.external_id ||
        verification.data?.external_source !== payload.external_source ||
        verification.data?.name !== payload.name ||
        !String(verification.data?.description_html || "").includes(payload.external_id)
      ) {
        throw new Error("Plane metadata verification did not match the requested payload");
      }
      updated += 1;
    } catch (error: any) {
      failures.push({
        ticketNumber,
        reason: String(error?.response?.data?.detail || error?.message || "Unknown error"),
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        linkedTickets: result.rows.length,
        updated,
        skipped,
        failed: failures.length,
        failures,
      },
      null,
      2
    )
  );

  if (failures.length > 0) process.exitCode = 1;
}

run()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
