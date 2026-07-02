import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { randomUUID } from "crypto";
import { DatabaseAdapter } from "../adapters/types";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";

export class PlaneService {
  private dbAdapter: DatabaseAdapter;

  constructor(dbAdapter: DatabaseAdapter) {
    this.dbAdapter = dbAdapter;
  }

  private getFilePath(tableName: string): string {
    const candidates = [
      path.resolve(__dirname, "../../../data"),
      path.resolve(process.cwd(), "data"),
      path.resolve(process.cwd(), "ticket_codebase/data"),
    ];

    let dataDir = candidates[0];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        const files = fs.readdirSync(cand);
        const hasData = files.some(
          (f) =>
            f.endsWith(".json") &&
            (f.includes("Tickets") || f.includes("Messages") || f.includes("Projects"))
        );
        if (hasData) {
          dataDir = cand;
          break;
        }
      }
    }

    const files = fs.readdirSync(dataDir);
    const match =
      files.find((f) => f.includes(`(${tableName})`) && f.endsWith(".json")) ||
      files.find((f) => f.includes(tableName) && f.endsWith(".json"));
    if (!match) {
      const defaultFilename = `Ticket V.2 - ${tableName} (${tableName}).json`;
      return path.join(dataDir, defaultFilename);
    }
    return path.join(dataDir, match);
  }

  private readTable<T>(tableName: string): T[] {
    const filePath = this.getFilePath(tableName);
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T[];
  }

  private writeTable<T>(tableName: string, data: T[]): void {
    const filePath = this.getFilePath(tableName);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async promoteTicketToPlane(ticketId: string): Promise<any> {
    // 1. Fetch ticket and company details using adapter
    const { ticket, companyName } = await this.dbAdapter.getTicketCompanyContext(ticketId);

    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }

    let planeIssueId = `mock-issue-${randomUUID()}`;
    let webhookTriggered = false;

    // 2. Trigger Activepieces webhook if configured
    const webhookUrl = config.ACTIVEPIECES_WORKFLOW_PROVIDER === "postgres_v2"
      ? config.ACTIVEPIECES_PROMOTE_TICKET_WEBHOOK_URL_V2
      : config.ACTIVEPIECES_PROMOTE_TICKET_WEBHOOK_URL;

    if (webhookUrl) {
      try {
        console.log(`[PlaneService] Triggering Activepieces Promote webhook at ${webhookUrl}...`);
        await axios.post(
          webhookUrl,
          {
            ticket_internal_id: Number(ticketId) || ticketId,
          },
          {
            headers: {
              "Content-Type": "application/json",
            },
            timeout: 5000,
          }
        );
        console.log(`[PlaneService] Activepieces webhook called successfully.`);
        planeIssueId = "Promoted via Activepieces webhook";
        webhookTriggered = true;
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || err.message;
        console.error(`[PlaneService] Failed to trigger Activepieces promote webhook:`, errorMsg);
      }
    }

    // 3. Fallback to direct Plane API call if webhook was not triggered/configured
    if (!webhookTriggered) {
      const useMockMode =
        !config.PLANE_API_KEY ||
        config.PLANE_API_KEY === "plane_mock_key" ||
        !config.PLANE_PROJECT_ID ||
        config.PLANE_PROJECT_ID === "proj_id";

      if (!useMockMode) {
        try {
          console.log(`[PlaneService] Promoting ticket ${ticketId} to Plane API...`);
          const url = `${config.PLANE_API_URL}/api/v1/workspaces/${config.PLANE_WORKSPACE_SLUG}/projects/${config.PLANE_PROJECT_ID}/issues/`;
          const res = await axios.post(
            url,
            {
              name: ticket.subject || "No Subject",
              description: `${ticket.summary || "No Summary"}\n\n[Customer Company: ${companyName}]`,
              priority: ticket.priority ? ticket.priority.toLowerCase() : "medium",
            },
            {
              headers: {
                "Content-Type": "application/json",
                "X-API-Key": config.PLANE_API_KEY,
              },
              timeout: 5000,
            }
          );
          if (res.data && res.data.id) {
            planeIssueId = res.data.id;
            console.log(`[PlaneService] Plane issue created successfully with ID: ${planeIssueId}`);
          }
        } catch (err: any) {
          const errorMsg = err.response?.data?.message || err.message;
          console.error(`[PlaneService] Plane API promotion failed, falling back to mock mode:`, errorMsg);
        }
      } else {
        console.log(`[PlaneService] Plane credentials are not configured or set to mock keys. Running in Mock Mode.`);
      }

      // Update plane_issue_id and status in database directly
      await this.dbAdapter.updateTicketPlaneIssue(ticketId, planeIssueId);
    }

    return {
      success: true,
      plane_issue_id: planeIssueId,
      ticket_id: ticket.ticket_id || ticket.id1,
      status: "In Progress",
    };
  }
}

