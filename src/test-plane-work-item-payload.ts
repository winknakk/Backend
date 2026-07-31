import assert from "assert";
import { buildPlaneWorkItemPayload } from "./services/planeService";

function run(): void {
  const payload = buildPlaneWorkItemPayload(
    {
      ticket_number: "TCK-2026-97545",
      conversation_id: 67,
      subject: "ระบบล่ม 400 Bad Request เข้าไม่ได้",
      summary: "ลูกค้าแจ้งว่า <ระบบ> ใช้งานไม่ได้\nต้องการความช่วยเหลือด่วน",
      status: "Backlog",
      priority: "Urgent",
      severity: "Critical",
      channel: "LINE",
      due_date: "2026-07-31T11:06:00.000+07:00",
    },
    "Example & Partners"
  );

  assert.strictEqual(payload.name, "[TCK-2026-97545] ระบบล่ม 400 Bad Request เข้าไม่ได้");
  assert.strictEqual(payload.external_source, "TicketX");
  assert.strictEqual(payload.external_id, "TCK-2026-97545");
  assert.strictEqual(payload.priority, "urgent");
  assert.strictEqual(payload.target_date, "2026-07-31");
  assert.match(payload.description_html, /TicketX ID/);
  assert.match(payload.description_html, /Conversation/);
  assert.match(payload.description_html, /#67/);
  assert.match(payload.description_html, /HTTP status/);
  assert.match(payload.description_html, /HTTP status:<\/strong> 400/);
  assert.match(payload.description_html, /SLA target/);
  assert.match(payload.description_html, /Example &amp; Partners/);
  assert.match(payload.description_html, /&lt;ระบบ&gt;/);
  assert.doesNotMatch(payload.description_html, /<ระบบ>/);

  const minimal = buildPlaneWorkItemPayload({
    id: 12,
    subject: "General support issue",
    summary: "No due date",
    priority: "None",
  });
  assert.strictEqual(minimal.external_id, "12");
  assert.strictEqual(minimal.priority, "none");
  assert.ok(!("target_date" in minimal));

  console.log("Plane work-item payload tests passed");
}

run();
