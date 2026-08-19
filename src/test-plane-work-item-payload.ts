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
      running_summary: "- Initial report\n- Screen flashes <often>",
      last_ai_summary: "Screen flashes & freezes",
      due_date: "2026-07-31T11:06:00.000+07:00",
    },
    "Example & Partners"
  );

  assert.strictEqual(payload.name, "[👤 Customer] [TCK-2026-97545] ระบบล่ม 400 Bad Request เข้าไม่ได้");
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
  assert.match(payload.description_html, /Customer update history/);
  assert.match(payload.description_html, /<ul><li>Initial report<\/li><li>Screen flashes &lt;often&gt;<\/li><\/ul>/);
  assert.match(payload.description_html, /Latest customer update/);
  assert.match(payload.description_html, /Screen flashes &amp; freezes/);
  assert.match(payload.description_html, /&lt;ระบบ&gt;/);
  assert.doesNotMatch(payload.description_html, /<ระบบ>/);

  // Test AI created ticket with label
  const aiPayload = buildPlaneWorkItemPayload(
    {
      ticket_number: "TCK-2026-11111",
      subject: "AI auto-triage ticket",
      summary: "AI detected incident",
      created_by_type: "AI",
      created_by_name: "PromptX Bot",
    },
    "Avalant",
    ["label-uuid-ai-generated"]
  );
  assert.strictEqual(aiPayload.name, "[🤖 AI] [TCK-2026-11111] AI auto-triage ticket");
  assert.deepStrictEqual(aiPayload.labels, ["label-uuid-ai-generated"]);
  assert.match(aiPayload.description_html, /🤖 AI Bot \(PromptX Bot\)/);

  // Test Human created ticket
  const humanPayload = buildPlaneWorkItemPayload(
    {
      ticket_number: "TCK-2026-22222",
      subject: "Human admin ticket",
      summary: "Admin created this",
      created_by_type: "HUMAN_AGENT",
      created_by_name: "Super Admin",
    },
    "Avalant",
    ["label-uuid-human-agent"]
  );
  assert.strictEqual(humanPayload.name, "[🎧 Human] [TCK-2026-22222] Human admin ticket");
  assert.deepStrictEqual(humanPayload.labels, ["label-uuid-human-agent"]);
  assert.match(humanPayload.description_html, /🎧 Human Agent \(Super Admin\)/);

  // Test duplicate badge prevention when subject already has prefix/suffix
  const duplicateCheck = buildPlaneWorkItemPayload({
    ticket_number: "TCK-2026-33333",
    subject: "[TCK-2026-33333] Existing title [🤖 AI]",
    summary: "Re-sync test",
    created_by_type: "AI",
  });
  assert.strictEqual(duplicateCheck.name, "[🤖 AI] [TCK-2026-33333] Existing title");

  const minimal = buildPlaneWorkItemPayload({
    id: 12,
    subject: "General support issue",
    summary: "No due date",
    priority: "None",
  });
  assert.strictEqual(minimal.name, "[👤 Customer] [12] General support issue");
  assert.strictEqual(minimal.external_id, "12");
  assert.strictEqual(minimal.priority, "none");
  assert.ok(!("target_date" in minimal));

  console.log("Plane work-item payload tests passed");
}

run();
