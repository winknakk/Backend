import fs from "fs";

const filePath = "C:/Users/akkha/TicketX/workflow-tooling/promptx_tools/workflow/Workflow latest_postgres/Main AI Core Flow (PostgreSQL V3)_postgres.json";

let data = JSON.parse(fs.readFileSync(filePath, "utf8"));

function updateHumanTicketNode(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    obj.forEach(updateHumanTicketNode);
    return;
  }

  if (obj.name === "step_create_human_ticket" && obj.settings && obj.settings.input) {
    obj.settings.input.query = `INSERT INTO tickets (conversation_id, project_id, ticket_number, subject, summary, status, priority, created_at) VALUES ($1::integer, $2::integer, $3, $4, $5, 'open', 'high', NOW()) RETURNING id, ticket_number, status;`;
    obj.settings.input.args = [
      "{{resolve_session[0].id}}",
      "{{resolve_session[0].project_id}}",
      "TCK-AUTO-HUMAN",
      "Issue Escalation: {{step_parse_gate.reason}}",
      "{{trigger.body.message}}"
    ];
    console.log("Updated step_create_human_ticket SQL in Main AI Core Flow!");
  }

  for (const key of Object.keys(obj)) {
    updateHumanTicketNode(obj[key]);
  }
}

updateHumanTicketNode(data);

fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
console.log("Successfully saved Main AI Core Flow (PostgreSQL V3)_postgres.json!");
