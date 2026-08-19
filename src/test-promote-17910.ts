import axios from "axios";

async function test17910() {
  const payload = {
    data: {
      org_id: "org_excise",
      subject: "ระบบ Excise ล่ม 506 Variant Also Negotiates",
      summary: "ลูกค้ารายงานว่าระบบ Excise ล่ม ขึ้น 506 Variant Also Negotiates",
      priority: "Urgent",
      severity: "Critical",
      project_id: 101,
      plane_title: "[TCK-2026-17910] ระบบ Excise ล่ม 506 Variant Also Negotiates",
      ticket_number: "TCK-2026-17910",
      plane_priority: "urgent",
      conversation_id: 1041,
      plane_external_id: "TCK-2026-17910",
      plane_target_date: "2026-08-18",
      plane_description_html: "<h3>TicketX support incident</h3>"
    },
    ticketId: "TCK-2026-17910"
  };

  console.log("Promoting TCK-2026-17910...");
  try {
    const res = await axios.post("http://127.0.0.1:3000/api/v1/internal/tickets/promote", payload);
    console.log("✅ Promotion Success:", res.data);
  } catch (e: any) {
    console.error("❌ Promotion Failed full error:", e.response ? { status: e.response.status, data: e.response.data } : e.message);
  }
}

test17910();
