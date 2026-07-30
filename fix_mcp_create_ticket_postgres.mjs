import fs from "fs";

const filePath = "C:/Users/akkha/TicketX/workflow-tooling/promptx_tools/workflow/Workflow latest_postgres/MCP Tool - create_ticket (PostgreSQL V3)_postgres.json";

let data = JSON.parse(fs.readFileSync(filePath, "utf8"));

function updateStep5(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    obj.forEach(updateStep5);
    return;
  }

  if (obj.name === "step_5" && obj.settings && obj.settings.input) {
    obj.settings.input.query = `INSERT INTO tickets (conversation_id, project_id, ticket_number, subject, summary, status, priority, severity, created_at) VALUES ($1::integer, $2::integer, $3, $4, $5, 'open', $6, $7, NOW()) RETURNING id, ticket_number, status;`;
    obj.settings.input.args = [
      "{{step_2[0].id}}",
      "11",
      "{{step_1.ticket_id}}",
      "{{trigger.subject}}",
      "{{trigger.summary}}",
      "{{trigger.priority}}",
      "{{trigger.severity}}"
    ];
    console.log("Updated step_5 SQL query in MCP Tool - create_ticket!");
  }

  for (const key of Object.keys(obj)) {
    updateStep5(obj[key]);
  }
}

updateStep5(data);

fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
console.log("Successfully saved MCP Tool - create_ticket (PostgreSQL V3)_postgres.json!");
