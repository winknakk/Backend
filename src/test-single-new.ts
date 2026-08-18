import axios from "axios";

async function testSingleNewTicket() {
  const newNum = `TCK-2026-${Math.floor(10000 + Math.random() * 90000)}`;
  const t = {
    data: {
      org_id: "org_excise",
      project_id: 101,
      subject: "ทดสอบสร้างตั๋วสดจาก Flow รูปภาพ",
      ticket_number: newNum,
      summary: "ทดสอบระบบ Excise พร้อมแนบรูปภาพ",
      priority: "Medium",
      severity: "Medium",
      conversation_id: 1041,
    }
  };

  console.log(`Promoting ${newNum}...`);
  try {
    const res = await axios.post("http://localhost:3000/api/v1/internal/tickets/promote", t);
    console.log(`✅ Success for ${newNum}:`, res.data);
  } catch (e: any) {
    console.log(`❌ Error for ${newNum}:`, e.response?.data || e.message);
  }
}

testSingleNewTicket();
