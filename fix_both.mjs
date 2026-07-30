import fs from "fs";

const file = "C:/Users/akkha/TicketX/workflow-tooling/promptx_tools/workflow/Workflow latest_postgres/Main AI Core Flow (PostgreSQL V3) .json";
const data = JSON.parse(fs.readFileSync(file, "utf8"));

function fixQuery(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    obj.forEach(fixQuery);
    return;
  }
  if (typeof obj.query === "string" && obj.query.includes("INSERT INTO tickets")) {
    obj.query = `INSERT INTO tickets (conversation_id, project_id, ticket_number, subject, summary, status, priority, severity, created_at) VALUES ($1::integer, $2::integer, $3, $4, $5, 'open', 'high', 'Critical', NOW()) RETURNING id, ticket_number, status;`;
    obj.args = [
      "{{resolve_session[0].id}}",
      "{{resolve_session[0].project_id}}",
      "TCK-AUTO-HUMAN",
      "Issue Escalation: {{step_parse_gate.reason}}",
      "{{trigger.body.message}}"
    ];
  }
  for (const k of Object.keys(obj)) {
    fixQuery(obj[k]);
  }
}

fixQuery(data);
fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
console.log("Fixed Main AI Core Flow (PostgreSQL V3) .json 100%!");
