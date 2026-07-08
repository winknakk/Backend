import { DatabaseAdapter } from "../adapters/types";
import { TicketInput, ExecutionResult } from "../schemas/validation";

export class TicketService {
  private dbAdapter: DatabaseAdapter;

  constructor(dbAdapter: DatabaseAdapter) {
    this.dbAdapter = dbAdapter;
  }

  async createTicket(input: TicketInput): Promise<ExecutionResult> {
    // 1. Calculate SLA Due Date dynamically based on project SLA policies
    let resolveHours = 120; // default fallback
    try {
      const { pool } = require("../adapters/postgres/PostgresAdapter");
      const projectId = parseInt(input.projectId, 10) || 1;
      const res = await pool.query(
        "SELECT resolve_hours FROM project_sla_policies WHERE project_id = $1 AND priority = $2 LIMIT 1",
        [projectId, input.priority]
      );
      if (res.rows.length > 0) {
        resolveHours = res.rows[0].resolve_hours || 120;
      }
    } catch (err: any) {
      console.error("Failed to query resolve_hours dynamically for ticket creation SLA calculation:", err.message);
    }

    const startDate = new Date();
    const dueDate = new Date(startDate.getTime() + resolveHours * 60 * 60 * 1000);

    // 2. Generate Sequential Mock Ticket Number: TCK-YYYY-[5-digit random]
    const currentYear = startDate.getFullYear();
    const randomSuffix = Math.floor(10000 + Math.random() * 90000);
    const ticketNumber = `TCK-${currentYear}-${randomSuffix}`;

    // 3. Save to database via Database Adapter
    return await this.dbAdapter.createTicket(input, dueDate.toISOString(), ticketNumber);
  }
}
