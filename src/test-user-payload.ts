import axios from "axios";

async function testUserPayload() {
  const body = {
    org_id: "org_excise",
    subject: "ระบบ Excise ล่ม 506 Variant Also Negotiates เข้าใช้งานไม่ได้",
    summary: "ลูกค้ารายงานว่าระบบ Excise ล่ม ขึ้น 506 Variant Also Negotiates",
    priority: "Urgent",
    severity: "Critical",
    project_id: 101,
    plane_title: "[TCK-2026-98502] ระบบ Excise ล่ม 506 Variant Also Negotiates เข้าใช้งานไม่ได้",
    ticket_number: "TCK-2026-98502",
    plane_priority: "urgent",
    conversation_id: 1041,
    plane_external_id: "TCK-2026-98502",
    plane_target_date: "2026-08-18",
    plane_description_html: "<h3>TicketX support incident</h3>"
  };

  console.log("Sending payload for TCK-2026-98502...");
  try {
    const res = await axios.post("http://localhost:3000/api/v1/internal/tickets/promote", body);
    console.log("✅ Promotion Response:", res.data);
  } catch (e: any) {
    console.log("❌ Promotion Failed:", e.response?.data || e.message);
  }
}

testUserPayload();
