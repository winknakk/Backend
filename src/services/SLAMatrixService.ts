import { pool } from "../adapters/postgres/PostgresAdapter";
import { createLogger } from "../observability/logger";

const logger = createLogger("SLAMatrixService");

export interface SLAPolicy {
  priority: string;
  priorityName: string;
  responseHours: number;
  resolveHours: number;
  serviceWindow: string;
}

export interface SLACalculationResult {
  dueDate: string;
  responseDueDate: string;
  resolveHours: number;
  responseHours: number;
  priorityName: string;
}

export class SLAMatrixService {
  private static readonly DEFAULT_SLA_MAP: Record<string, { name: string; response: number; resolve: number }> = {
    P1: { name: "Urgent", response: 1, resolve: 4 },
    urgent: { name: "Urgent", response: 1, resolve: 4 },
    P2: { name: "High", response: 2, resolve: 8 },
    high: { name: "High", response: 2, resolve: 8 },
    P3: { name: "Medium", response: 4, resolve: 24 },
    medium: { name: "Medium", response: 4, resolve: 24 },
    P4: { name: "Low", response: 8, resolve: 72 },
    low: { name: "Low", response: 8, resolve: 72 },
  };

  async calculateSLADueDate(
    projectId: string | number,
    priority: string,
    createdAt: Date = new Date()
  ): Promise<SLACalculationResult> {
    const normPriority = (priority || "P3").trim();
    let resolveHours = 24;
    let responseHours = 4;
    let priorityName = "Medium";

    // 1. Check project SLA policy from DB if available
    try {
      const parsedProjectId = typeof projectId === "number" ? projectId : parseInt(String(projectId), 10);
      if (!isNaN(parsedProjectId)) {
        const { rows } = await pool.query(
          `SELECT priority_name, response_hours, resolve_hours 
           FROM project_sla_policies 
           WHERE project_id = $1 AND LOWER(priority) = LOWER($2) LIMIT 1`,
          [parsedProjectId, normPriority]
        );

        if (rows.length > 0) {
          priorityName = rows[0].priority_name || priorityName;
          responseHours = rows[0].response_hours || responseHours;
          resolveHours = rows[0].resolve_hours || resolveHours;
        } else {
          const fallback = SLAMatrixService.DEFAULT_SLA_MAP[normPriority] || SLAMatrixService.DEFAULT_SLA_MAP.P3;
          priorityName = fallback.name;
          responseHours = fallback.response;
          resolveHours = fallback.resolve;
        }
      }
    } catch (err: any) {
      logger.debug({ error: err.message }, "SLA project policy lookup fallback to default map");
      const fallback = SLAMatrixService.DEFAULT_SLA_MAP[normPriority] || SLAMatrixService.DEFAULT_SLA_MAP.P3;
      priorityName = fallback.name;
      responseHours = fallback.response;
      resolveHours = fallback.resolve;
    }

    const baseMs = createdAt.getTime();
    const dueDate = new Date(baseMs + resolveHours * 60 * 60 * 1000).toISOString();
    const responseDueDate = new Date(baseMs + responseHours * 60 * 60 * 1000).toISOString();

    return {
      dueDate,
      responseDueDate,
      resolveHours,
      responseHours,
      priorityName,
    };
  }

  async checkSLABreachStatus(ticket: {
    createdAt: string | Date;
    dueDate: string | Date;
    status: string;
  }): Promise<{ isBreached: boolean; hoursRemaining: number }> {
    const status = (ticket.status || "").toLowerCase();
    if (status === "done" || status === "closed" || status === "resolved") {
      return { isBreached: false, hoursRemaining: 999 };
    }

    const now = Date.now();
    const dueMs = new Date(ticket.dueDate).getTime();
    const diffMs = dueMs - now;
    const hoursRemaining = Math.round((diffMs / (1000 * 60 * 60)) * 10) / 10;

    return {
      isBreached: diffMs < 0,
      hoursRemaining,
    };
  }
}
