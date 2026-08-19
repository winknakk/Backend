import axios from "axios";

async function testNgrok() {
  const payload = {
    data: {
      org_id: "org_excise",
      subject: "ระบบ Excise ล่ม 506 Variant Also Negotiates เข้าใช้งานไม่ได้",
      summary: "ลูกค้ารายงานว่าระบบ Excise ล่ม ขึ้น 506 Variant Also Negotiates",
      priority: "Urgent",
      severity: "Critical",
      project_id: 101,
      plane_title: "[TCK-2026-99999] ระบบ Excise ล่ม 506 Variant Also Negotiates เข้าใช้งานไม่ได้",
      ticket_number: "TCK-2026-99999",
      plane_priority: "urgent",
      conversation_id: 1041,
      plane_external_id: "TCK-2026-99999",
      plane_target_date: "2026-08-19",
      plane_description_html: "<h3>TicketX support incident</h3>"
    },
    ticketId: "TCK-2026-99999"
  };

  console.log("Calling public ngrok URL https://squid-gray-chowtime.ngrok-free.dev/api/v1/internal/tickets/promote...");
  try {
    const res = await axios.post("https://squid-gray-chowtime.ngrok-free.dev/api/v1/internal/tickets/promote", payload, {
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true"
      }
    });
    console.log("✅ Ngrok Promotion Success:", res.data);
  } catch (e: any) {
    console.log("❌ Ngrok Promotion Failed:", e.response?.data || e.message);
  }
}

testNgrok();
