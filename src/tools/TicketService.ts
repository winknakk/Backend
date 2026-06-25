import { DatabaseAdapter } from "../adapters/types";
import { TicketInput, ExecutionResult } from "../schemas/validation";

export class TicketService {
  private dbAdapter: DatabaseAdapter;

  constructor(dbAdapter: DatabaseAdapter) {
    this.dbAdapter = dbAdapter;
  }

  async createTicket(input: TicketInput): Promise<ExecutionResult> {
    // 1. Calculate SLA Due Date
    const severity = input.severity;
    
    const slaConfig: Record<string, number> = {
      "Critical": 4, 
      "High": 12,    
      "Medium": 48,  
      "Low": 120     
    };

    const resolveHours = slaConfig[severity] || 120;
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
