import axios from "axios";

async function promoteBothFailedTickets() {
  const t1 = {
    data: {
      org_id: "org_excise",
      project_id: 101,
      subject: "ขอคำแนะนำวิธีเปิดใช้งานระบบหรือบริการ",
      ticket_number: "TCK-2026-63335",
      summary: "ลูกค้ารายงานขอคำแนะนำวิธีเปิดใช้งานระบบหรือบริการ",
      priority: "Medium",
      severity: "Medium",
      conversation_id: 1041,
    }
  };

  const t2 = {
    data: {
      org_id: "org_excise",
      project_id: 101,
      subject: "ปัญหาที่แจ้งมาพร้อมรูปภาพ",
      ticket_number: "TCK-2026-42545",
      summary: "ลูกค้าแจ้งปัญหาพร้อมรูปภาพ",
      priority: "High",
      severity: "High",
      conversation_id: 1041,
    }
  };

  for (const t of [t1, t2]) {
    console.log(`Promoting ${t.data.ticket_number}...`);
    try {
      const res = await axios.post("http://localhost:3000/api/v1/internal/tickets/promote", t);
      console.log(`✅ Success for ${t.data.ticket_number}:`, res.data);
    } catch (e: any) {
      console.log(`❌ Error for ${t.data.ticket_number}:`, e.response?.data || e.message);
    }
  }
}

promoteBothFailedTickets();
